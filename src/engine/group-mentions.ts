/**
 * Menções por nome num grupo: a Sophie pede "marcar a Fátima" e o adaptador
 * acha a pessoa entre os participantes pelo nome que ela usa no WhatsApp (ou
 * pelo nome salvo nos contatos da conta).
 *
 * O número nunca sai daqui: quem chama recebe só o nome pedido, o estado
 * (achou, não achou, mais de uma pessoa) e os nomes das candidatas. O id só é
 * usado dentro do adaptador, na hora do envio.
 */

export interface MentionCandidate {
  /** Id do participante (@c.us ou @lid) — nunca devolvido pela API. */
  id: string;
  /** Nomes da pessoa: salvo nos contatos, o do WhatsApp, o curto. */
  labels: string[];
}

export type MentionStatus = 'ok' | 'not_found' | 'ambiguous';

export interface MentionResolution {
  name: string;
  status: MentionStatus;
  /** Nome com que a pessoa foi achada (ou das candidatas, se ambíguo). */
  matches: string[];
  /** Só dentro do adaptador. */
  id?: string;
}

export const MAX_MENTIONS = 5;

export function normalizeMentionName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Igual ao nome inteiro, ou ao começo dele palavra por palavra ("fatima" casa "fatima souza"). */
function labelMatches(label: string, wanted: string): boolean {
  const l = normalizeMentionName(label);
  if (!l || !wanted) return false;
  return l === wanted || l.startsWith(wanted + ' ');
}

export function resolveMentions(names: string[], candidates: MentionCandidate[]): MentionResolution[] {
  return names.slice(0, MAX_MENTIONS).map((name) => {
    const wanted = normalizeMentionName(name);
    const found = candidates.filter((c) => c.labels.some((l) => labelMatches(l, wanted)));
    // Um nome igual por inteiro vence quem só começa igual ("Ana" vs "Ana Paula").
    const exact = found.filter((c) => c.labels.some((l) => normalizeMentionName(l) === wanted));
    const chosen = exact.length === 1 ? exact : found;
    const shown = (c: MentionCandidate) => c.labels.find((l) => labelMatches(l, wanted)) ?? c.labels[0] ?? '';
    if (chosen.length === 1) return { name, status: 'ok', matches: [shown(chosen[0])], id: chosen[0].id };
    if (chosen.length === 0) return { name, status: 'not_found', matches: [] };
    return { name, status: 'ambiguous', matches: chosen.map(shown).slice(0, 5) };
  });
}

/** O que a API devolve: sem id. */
export function publicResolutions(resolved: MentionResolution[]): Omit<MentionResolution, 'id'>[] {
  return resolved.map(({ name, status, matches }) => ({ name, status, matches }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Troca cada "@Nome" do texto pelo "@<usuário>" que o WhatsApp transforma no
 * nome azul. O texto precisa trazer "@Nome" para cada pessoa marcada.
 */
export function applyMentions(text: string, resolved: MentionResolution[]): { text: string; ids: string[] } {
  let out = text;
  const ids: string[] = [];
  for (const r of resolved) {
    if (r.status !== 'ok' || !r.id) throw new Error(`mention_unresolved:${r.status}`);
    const token = new RegExp(`@${escapeRegExp(r.name.replace(/^@+/, ''))}(?![\\p{L}\\p{N}_])`, 'iu');
    if (!token.test(out)) throw new Error('mention_not_in_text');
    out = out.replace(token, `@${r.id.split('@')[0]}`);
    ids.push(r.id);
  }
  return { text: out, ids };
}
