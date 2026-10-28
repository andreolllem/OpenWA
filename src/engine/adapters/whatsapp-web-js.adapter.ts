import { EventEmitter } from 'events';
import { Client, LocalAuth, Message, MessageMedia } from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { applyMentions, publicResolutions, resolveMentions, type MentionCandidate, type MentionResolution } from '../group-mentions';
import {
  GroupChat,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
} from '../types/whatsapp-web-js.types';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

/**
 * O id serializado de uma mensagem, mesmo quando o modelo não o traz pronto.
 *
 * Ordem: o campo normal; o nome minificado que algumas builds usam; e, por
 * último, a reconstrução a partir das partes, que é o formato que o próprio
 * WhatsApp Web monta (fromMe_remote_id).
 */
function resolveSerializedMessageId(id: unknown): string | undefined {
  const obj = id && typeof id === 'object' ? (id as Record<string, unknown>) : null;
  if (!obj) return undefined;
  if (typeof obj._serialized === 'string' && obj._serialized) return obj._serialized;
  if (typeof obj.$1 === 'string' && obj.$1) return obj.$1;
  if (typeof obj.remote === 'string' && typeof obj.id === 'string') {
    return `${Boolean(obj.fromMe)}_${obj.remote}_${obj.id}`;
  }
  return undefined;
}

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  /** Os ids da própria conta (número e LID), só a parte antes do @ — para saber quando foi mencionada. */
  private ownUsers = new Set<string>();
  private callbacks: EngineEventCallbacks = {};

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ];

      // Add proxy configuration if provided
      if (this.config.proxy) {
        puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
        this.logger.log(
          `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
        );
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          args: puppeteerArgs,
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
    });

    this.client.on('ready', () => {
      try {
        const info = this.client?.info;
        this.phoneNumber = info?.wid?.user || null;
        this.pushName = info?.pushname || null;
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
        void this.loadOwnUsers();
      } catch (error) {
        this.logger.error('Error getting client info', String(error));
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.('', '');
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async msg => {
      try {
        // Current WhatsApp Web builds do not always populate id._serialized on
        // the message model — the field arrives under a minified name, or only
        // as its parts. An inbound message with no id cannot be acked,
        // deduplicated or reacted to, so rebuild it rather than drop it, and
        // write it back so everything downstream (including whatsapp-web.js
        // itself) sees a normal message.
        const serializedMessageId = resolveSerializedMessageId(msg.id);
        const usedMessageIdCompatibilityFallback = Boolean(
          msg.id && !(msg.id as { _serialized?: string })._serialized && serializedMessageId,
        );
        if (usedMessageIdCompatibilityFallback && serializedMessageId) {
          try {
            (msg.id as { _serialized?: string })._serialized = serializedMessageId;
          } catch {
            try {
              (msg as { id: unknown }).id = { ...msg.id, _serialized: serializedMessageId };
            } catch {
              this.logger.warn('Could not apply WhatsApp message id compatibility fallback');
            }
          }
        }

        const incomingMessage: IncomingMessage = {
          id: serializedMessageId ?? '',
          from: msg.from,
          to: msg.to,
          chatId: msg.from,
          body: msg.body,
          type: msg.type,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe,
          isGroup: msg.from.endsWith('@g.us'),
        };

        // Em grupo, `from` é o grupo: quem escreveu vem em `author`, e o nome
        // que a pessoa usa no WhatsApp em notifyName. As menções (@Sophie)
        // decidem quando a Sophie é chamada. Ids podem vir como objeto nas
        // builds atuais — mesmo tratamento do id da mensagem.
        if (incomingMessage.isGroup) {
          const author = resolveSerializedMessageId(msg.author) ?? (typeof msg.author === 'string' ? msg.author : undefined);
          if (author) incomingMessage.author = author;
          const notifyName = (msg as unknown as { _data?: { notifyName?: unknown } })._data?.notifyName;
          if (typeof notifyName === 'string' && notifyName.trim()) incomingMessage.authorName = notifyName.trim().slice(0, 60);
          const mentioned = (msg.mentionedIds ?? [])
            .map((m: unknown) => (typeof m === 'string' ? m : resolveSerializedMessageId(m)))
            .filter((m: string | undefined): m is string => Boolean(m));
          if (mentioned.length) {
            incomingMessage.mentionedIds = mentioned;
            if (!this.ownUsers.size) await this.loadOwnUsers();
            incomingMessage.mentionsMe = mentioned.some((m: string) => this.ownUsers.has(m.split('@')[0]));
          }
        }

        // Handle media
        // Mídia de grupo não é baixada: são fotos e vídeos de terceiros, que o
        // resumo para o André não lê, e o base64 encheria cada webhook.
        if (msg.hasMedia && !incomingMessage.isGroup) {
          try {
            const media = await this.downloadInboundMedia(msg, serializedMessageId);
            if (media) {
              incomingMessage.media = {
                mimetype: media.mimetype,
                filename: media.filename || undefined,
                data: media.data,
              };
            }
          } catch (error) {
            // O id resolvido entra no log porque a falha de mídia quase sempre
            // acompanha uma mensagem cujo id veio fora do formato esperado.
            this.logger.error('Error downloading media', String(error), {
              messageIdResolved: Boolean(serializedMessageId),
              messageIdCompatibilityFallback: usedMessageIdCompatibilityFallback,
              messageType: typeof msg.type === 'string' ? msg.type : 'unknown',
            } as never);
          }
        }

        // Handle quoted message
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            incomingMessage.quotedMessage = {
              id: quoted.id._serialized,
              body: quoted.body,
            };
          } catch (error) {
            this.logger.error('Error getting quoted message', String(error));
          }
        }

        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      this.callbacks.onMessageAck?.(msg.id._serialized, ack);
    });

    this.client.on('disconnected', reason => {
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', () => {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onDisconnected?.('Authentication failed');
    });
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        // Use destroy instead of logout to preserve session data
        // This allows reconnecting without needing to scan QR again
        await this.client.destroy();
      } catch (error) {
        this.logger.warn('Destroy client failed:', String(error));
        // Already destroyed or not initialized - ignore
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    if (this.client) {
      try {
        // Logout clears session data - user will need to scan QR again
        await this.client.logout();
      } catch (error) {
        this.logger.warn('Logout failed:', String(error));
        // Fall back to destroy if logout fails
        try {
          await this.client.destroy();
        } catch (destroyError) {
          this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
        }
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  async sendTextMessage(chatId: string, text: string, mentionNames?: string[]): Promise<MessageResult> {
    this.ensureReady();
    // Grupo vai direto: getNumberId é só para número de pessoa.
    if (chatId.endsWith('@g.us')) {
      let body = text;
      let mentions: string[] | undefined;
      if (mentionNames?.length) {
        // Resolve de novo na hora do envio: quem não for achado (ou for mais de
        // uma pessoa) impede o envio, em vez de mandar sem marcar.
        const resolved = resolveMentions(mentionNames, await this.groupMentionCandidates(chatId));
        const applied = applyMentions(text, resolved);
        body = applied.text;
        mentions = applied.ids;
      }
      const sent = mentions
        ? await this.client!.sendMessage(chatId, body, { mentions })
        : await this.client!.sendMessage(chatId, body);
      return { id: sent?.id?._serialized ?? '', timestamp: sent?.timestamp ?? Math.floor(Date.now() / 1000) };
    }
    const number = chatId.replace(/@c\.us$/, '');
    const numberId = await this.client!.getNumberId(number);
    const resolvedId = numberId ? numberId._serialized : chatId;
    const msg = await this.client!.sendMessage(resolvedId, text);
    // whatsapp-web.js may resolve sendMessage without returning a Message.
    // The message has gone out either way; turning that into an HTTP 500
    // would make a delivered message look like a failure and invite a
    // duplicate send.
    return {
      id: msg?.id?._serialized ?? '',
      timestamp: msg?.timestamp ?? Math.floor(Date.now() / 1000),
    };
  }

  async resolveGroupMentions(groupId: string, names: string[]): Promise<Omit<MentionResolution, 'id'>[]> {
    this.ensureReady();
    return publicResolutions(resolveMentions(names, await this.groupMentionCandidates(groupId)));
  }

  /**
   * Participantes do grupo com os nomes que dá para comparar: o salvo nos
   * contatos da conta, o que a pessoa usa no WhatsApp e o curto. A própria
   * conta fica de fora.
   *
   * Lê direto da página (GroupMetadata + Contact): o `getChatById` da
   * whatsapp-web.js 1.34.7 falha nas builds atuais do WhatsApp Web com um erro
   * interno ("r: r", visto em 28/10/2026), como já acontecia nas reações. O
   * caminho da biblioteca fica como reserva.
   */
  private async groupMentionCandidates(groupId: string): Promise<MentionCandidate[]> {
    if (!this.ownUsers.size) await this.loadOwnUsers();
    let raw: { id: string; labels: string[] }[];
    try {
      raw = await this.groupParticipantsFromPage(groupId);
    } catch (error) {
      this.logger.warn(`group participants from the page failed: ${error instanceof Error ? error.message : String(error)}`);
      raw = await this.groupParticipantsFromLibrary(groupId);
    }
    const out: MentionCandidate[] = [];
    for (const { id, labels } of raw) {
      if (this.ownUsers.has(id.split('@')[0].split(':')[0])) continue;
      const clean: string[] = [];
      for (const v of labels) {
        if (typeof v === 'string' && v.trim() && !clean.includes(v.trim())) clean.push(v.trim());
      }
      if (clean.length) out.push({ id, labels: clean });
    }
    this.logger.log(`Group mention candidates: ${out.length} of ${raw.length} participant(s) with a name`);
    return out;
  }

  private async groupParticipantsFromPage(groupId: string): Promise<{ id: string; labels: string[] }[]> {
    const result = await (this.client as unknown as {
      pupPage: { evaluate: <T>(fn: (gid: string) => Promise<T>, arg: string) => Promise<T> };
    }).pupPage.evaluate(async (gid: string) => {
      const w = window as unknown as { require: (m: string) => any };
      const coll = w.require('WAWebCollections');
      const wid = w.require('WAWebWidFactory').createWid(gid);
      const metaColl = coll.GroupMetadata || coll.WAWebGroupMetadataCollection;
      const contacts = coll.Contact || coll.WAWebContactCollection;
      let meta = coll.Chat?.get?.(wid)?.groupMetadata;
      if (!meta && metaColl) {
        meta = metaColl.get(wid);
        if (!meta && typeof metaColl.find === 'function') meta = await metaColl.find(wid);
      }
      if (!meta) return { error: `group_not_found (chat:${!!coll.Chat}, metadata:${!!metaColl})` };
      const parts = meta.participants?.getModelsArray?.() ?? meta.participants?._models ?? [];
      return {
        participants: parts.map((p: any) => {
          const id = p.id?._serialized ?? String(p.id);
          const c = contacts?.get?.(p.id) ?? contacts?.get?.(id);
          return {
            id,
            labels: [c?.name, c?.pushname, c?.shortName, c?.verifiedName, c?.notifyName].filter(
              (v: unknown) => typeof v === 'string',
            ),
          };
        }),
      };
    }, groupId);
    if (!result || (result as { error?: string }).error) throw new Error((result as { error?: string })?.error ?? 'no_result');
    return (result as { participants: { id: string; labels: string[] }[] }).participants;
  }

  private async groupParticipantsFromLibrary(groupId: string): Promise<{ id: string; labels: string[] }[]> {
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) throw new Error('not_a_group');
    const out: { id: string; labels: string[] }[] = [];
    for (const p of (chat as unknown as GroupChat).participants || []) {
      const id = String(p.id._serialized);
      try {
        const contact = await this.client!.getContactById(id);
        out.push({ id, labels: [contact.name, contact.pushname, contact.shortName].filter((v): v is string => typeof v === 'string') });
      } catch {
        // Sem contato, a pessoa só não pode ser achada pelo nome.
      }
    }
    return out;
  }

  /**
   * Os ids da conta conectada. Em grupo, a menção pode vir pelo número (@c.us)
   * ou pelo LID (@lid), conforme o grupo — guarda os dois. Falha não quebra
   * nada: sem ids, mentionsMe sai false e a Sophie só registra.
   */
  private async loadOwnUsers(): Promise<void> {
    try {
      const ids = await (this.client as unknown as {
        pupPage: { evaluate: (fn: () => unknown) => Promise<unknown> };
      }).pupPage.evaluate(() => {
        const w = window as unknown as { require: (m: string) => Record<string, () => { _serialized?: string } | null> };
        const me = w.require('WAWebUserPrefsMeUser');
        return [me.getMaybeMePnUser?.()?._serialized, me.getMaybeMeLidUser?.()?._serialized];
      });
      const users = (Array.isArray(ids) ? ids : [])
        .filter((id): id is string => typeof id === 'string' && id.includes('@'))
        .map((id) => id.split('@')[0].split(':')[0]);
      const wid = this.client?.info?.wid?._serialized;
      if (wid) users.push(wid.split('@')[0]);
      this.ownUsers = new Set(users.filter(Boolean));
      this.logger.log(`Own ids loaded: ${this.ownUsers.size}`);
    } catch (error) {
      this.logger.warn('Could not load own ids', String(error));
    }
  }

  /**
   * Presença de digitação. Não existe na API pública do whatsapp-web.js, então
   * chama o estado de chat pela própria página — é o mesmo caminho que a
   * interface do WhatsApp Web usa.
   *
   * O número é resolvido como no envio: um chatId que ainda não está na lista
   * de conversas precisa virar o id que o protocolo reconhece.
   */
  async setTyping(chatId: string, typing: boolean): Promise<void> {
    this.ensureReady();
    const number = chatId.replace(/@c\.us$/, '');
    const numberId = await this.client!.getNumberId(number);
    const resolvedId = numberId ? numberId._serialized : chatId;
    await (this.client! as unknown as {
      pupPage: { evaluate: (fn: unknown, arg: unknown) => Promise<void> };
    }).pupPage.evaluate(
      ({ chatId: id, state }: { chatId: string; state: string }) => {
        const w = window as unknown as { WWebJS: { sendChatstate: (s: string, c: string) => unknown } };
        return w.WWebJS.sendChatstate(state, id);
      },
      { chatId: resolvedId, state: typing ? 'typing' : 'stop' },
    );
  }

  /**
   * Baixa a mídia de uma mensagem recebida.
   *
   * O `msg.downloadMedia()` da whatsapp-web.js 1.34.7 chama o
   * `downloadAndMaybeDecrypt` do WhatsApp Web sem o `mimetype`. As builds
   * atuais (visto em 16/10/2026) recusam isso com "InvalidMediaFileType:
   * Unexpected mimetype application/octet-stream for media type image" — a
   * foto já está baixada na página, só a decifração falha, e o webhook saía
   * sem mídia. É o mesmo caminho da biblioteca, com o tipo do arquivo; se a
   * mensagem não for achada na página, cai no método da biblioteca.
   */
  private async downloadInboundMedia(
    msg: Message,
    serializedMessageId: string | undefined,
  ): Promise<{ mimetype: string; data: string; filename?: string | null } | undefined> {
    if (!serializedMessageId) return (await msg.downloadMedia()) ?? undefined;
    const page = (this.client as unknown as {
      pupPage: { evaluate: <T>(fn: (id: string) => Promise<T>, arg: string) => Promise<T> };
    }).pupPage;
    const result = await page.evaluate(async (msgId: string) => {
      const w = window as unknown as {
        require: (m: string) => any;
        WWebJS: { arrayBufferToBase64Async: (b: ArrayBuffer) => Promise<string> };
      };
      const Msg = w.require('WAWebCollections').Msg;
      const m = Msg.get(msgId) || (await Msg.getMessagesById([msgId]))?.messages?.[0];
      if (!m) return { notFound: true as const };
      if (!m.mediaData || m.mediaData.mediaStage === 'REUPLOADING') return null;
      if (m.mediaData.mediaStage !== 'RESOLVED') {
        await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      }
      if (String(m.mediaData.mediaStage).includes('ERROR') || m.mediaData.mediaStage === 'FETCHING') return null;
      const qpl = { addAnnotations() { return this; }, addPoint() { return this; } };
      try {
        const decrypted = await w.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: m.directPath,
          encFilehash: m.encFilehash,
          filehash: m.filehash,
          mediaKey: m.mediaKey,
          mediaKeyTimestamp: m.mediaKeyTimestamp,
          type: m.type,
          mimetype: m.mimetype,
          signal: new AbortController().signal,
          downloadQpl: qpl,
        });
        return {
          data: await w.WWebJS.arrayBufferToBase64Async(decrypted),
          mimetype: m.mimetype as string,
          filename: (m.filename as string | undefined) ?? null,
        };
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    }, serializedMessageId);
    if (result && 'notFound' in result) return (await msg.downloadMedia()) ?? undefined;
    return result ?? undefined;
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      caption: media.caption,
    });

    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = await this.client!.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    return numberId !== null;
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const chats = await this.client!.getChats();

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    return groups.map(g => {
      const groupChat = g as unknown as GroupChat;
      return {
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(
          p => p.isAdmin && p.id._serialized === this.client?.info?.wid?._serialized,
        ),
      };
    });
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const { Location } = await import('whatsapp-web.js');
    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.client!.sendMessage(chatId, loc);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const msg = await this.client!.sendMessage(chatId, vcard, {
      parseVCards: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      sendMediaAsSticker: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    // Find the message to quote
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    const msg = await quotedMsg.reply(text);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const chat = await this.client!.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await msgToForward.forward(toChatId);
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  // Reactions (Phase 3)
  /**
   * Finds a message by its serialized id, without going through the chat.
   *
   * The chat route (getChatById + fetchMessages) fails before it can even
   * look: a @c.us id raises "No LID for user" and a @lid id raises an
   * internal WhatsApp error, so every reaction came back as a 500. Both are
   * chat-resolution failures, not reaction failures — the message itself is
   * reachable by id. The chat scan is kept as a fallback for the case the
   * store no longer holds the message, and its failure is logged rather than
   * thrown, so the caller sees the original "not found" instead of a
   * resolution error from a fallback.
   */
  private async findMessage(chatId: string, messageId: string): Promise<Message | null> {
    try {
      const direct = await this.client!.getMessageById(messageId);
      if (direct) return direct;
    } catch (err) {
      this.logger.warn(
        `getMessageById failed for ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const chat = await this.client!.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 100 });
      return messages.find(m => m.id._serialized === messageId) ?? null;
    } catch (err) {
      this.logger.warn(
        `chat scan failed for ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const message = await this.findMessage(chatId, messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    void message; // existence check only — the reaction goes by id, below.
    // Not message.react(): it calls client.sendReaction(this.id._serialized),
    // and in current WhatsApp Web builds the message model carries no
    // _serialized — the page then hits `if (!messageId) return null` and
    // no-ops without throwing, so every reaction reported success and none
    // appeared. The id the caller handed us is the one that resolves, so send
    // with it, and make a miss an error instead of silence.
    const sent = await (this.client! as unknown as {
      pupPage: { evaluate: (fn: unknown, ...args: unknown[]) => Promise<string> };
    }).pupPage
      .evaluate(
        async (id: string, reaction: string) => {
          const w = window as unknown as { require: (m: string) => any };
          const coll = w.require('WAWebCollections');
          const msg =
            coll.Msg.get(id) || (await coll.Msg.getMessagesById([id]))?.messages?.[0];
          if (!msg) return 'message-not-in-store';
          await w.require('WAWebSendReactionMsgAction').sendReactionToMsg(msg, reaction);
          return 'sent';
        },
        messageId,
        emoji,
      )
      .catch((err: unknown) => {
        this.logger.error(
          `react failed for ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      });
    if (sent !== 'sent') {
      throw new Error(`Reaction not delivered for ${messageId}: ${sent}`);
    }
    this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    const message = await this.findMessage(chatId, messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  // Labels (Phase 3) - WhatsApp Business only
  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    const labels = await (this.client as unknown as BusinessClient).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.ensureReady();
    const label = await (this.client as unknown as BusinessClient).getLabelById(labelId);
    if (!label) {
      return null;
    }
    return {
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    };
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const labels = await (chat as unknown as GroupChat).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).addLabel(labelId);
    this.logger.log(`Added label ${labelId} to chat ${chatId}`);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).removeLabel(labelId);
    this.logger.log(`Removed label ${labelId} from chat ${chatId}`);
  }

  // Channels/Newsletter (Phase 3)
  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    const channels = await (this.client as unknown as BusinessClient).getChannels();
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        return null;
      }
      return {
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
        inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
        subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
        verified: ch.verified ? Boolean(ch.verified) : undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to get channel: ${channelId}`, String(error));
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const ch = await (this.client as unknown as BusinessClient).subscribeToChannel(inviteCode);
    this.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);
    return {
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
    };
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await (this.client as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    this.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        throw new Error(`Channel ${channelId} not found`);
      }
      const messages = await ch.fetchMessages({ limit });
      if (!messages) {
        return [];
      }
      return messages.map(msg => ({
        id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),
        body: String(msg.body || ''),
        timestamp: Number(msg.timestamp),
        hasMedia: Boolean(msg.hasMedia),
        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to get channel messages: ${String(error)}`);
      return [];
    }
  }

  // ========== Gap Quick Wins Implementation ==========

  // Delete Message
  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await message.delete(forEveryone);
    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  // Block Contact
  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.block();
    this.logger.log(`Blocked contact ${contactId}`);
  }

  // Unblock Contact
  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.unblock();
    this.logger.log(`Unblocked contact ${contactId}`);
  }

  // Get Group Invite Code
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  // Revoke Group Invite Code
  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    // whatsapp-web.js has limited Status API support
    // This is a stub that can be enhanced when the library adds support
    this.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.ensureReady();
    this.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');
    return [];
  }

  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native status posting
    // This would require using the underlying WhatsApp Web API directly
    throw new Error('postTextStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postImageStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postVideoStatus not yet implemented in whatsapp-web.js adapter');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    this.ensureReady();
    throw new Error('deleteStatus not yet implemented in whatsapp-web.js adapter');
  }

  // ========== Catalog (Phase 3) ==========

  async getCatalog(): Promise<Catalog | null> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native Catalog API support
    this.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ensureReady();
    this.logger.warn('getProducts not implemented in whatsapp-web.js adapter');
    return {
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.ensureReady();
    this.logger.warn('getProduct not implemented in whatsapp-web.js adapter');
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendProduct not yet implemented in whatsapp-web.js adapter');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendCatalog not yet implemented in whatsapp-web.js adapter');
  }

  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      throw new Error('WhatsApp client is not ready');
    }
  }
}
