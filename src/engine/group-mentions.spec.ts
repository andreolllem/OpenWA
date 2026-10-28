import { applyMentions, publicResolutions, resolveMentions } from './group-mentions';

const people = [
  { id: '5511900000001@c.us', labels: ['Fátima Souza'] },
  { id: '123456789012345@lid', labels: ['Ana'] },
  { id: '5511900000003@c.us', labels: ['Ana Paula'] },
  { id: '5511900000004@c.us', labels: ['Rafa', 'Rafael Lima'] },
  { id: '5511900000005@c.us', labels: ['Rafael Costa'] },
];

describe('group mentions', () => {
  it('acha pelo nome, sem acento e pelo primeiro nome', () => {
    const [r] = resolveMentions(['fatima'], people);
    expect(r.status).toBe('ok');
    expect(r.matches).toEqual(['Fátima Souza']);
  });

  it('nome igual por inteiro vence quem só começa igual', () => {
    expect(resolveMentions(['Ana'], people)[0].id).toBe('123456789012345@lid');
  });

  it('duas pessoas = ambíguo; ninguém = não achado', () => {
    const [amb, none] = resolveMentions(['Rafael', 'Joana'], people);
    expect(amb.status).toBe('ambiguous');
    expect(amb.matches).toEqual(['Rafael Lima', 'Rafael Costa']);
    expect(none.status).toBe('not_found');
  });

  it('a API nunca devolve id nem número', () => {
    const out = JSON.stringify(publicResolutions(resolveMentions(['Fátima', 'Ana'], people)));
    expect(out).not.toMatch(/5511|@c\.us|@lid|1234567/);
  });

  it('troca @Nome pelo usuário e devolve os ids', () => {
    const res = resolveMentions(['Fátima'], people);
    expect(applyMentions('Oi @Fátima, a reunião mudou.', res)).toEqual({
      text: 'Oi @5511900000001, a reunião mudou.',
      ids: ['5511900000001@c.us'],
    });
  });

  it('não manda se alguém não foi achado ou se o texto não traz @Nome', () => {
    expect(() => applyMentions('Oi @Joana', resolveMentions(['Joana'], people))).toThrow('mention_unresolved');
    expect(() => applyMentions('Oi Fátima', resolveMentions(['Fátima'], people))).toThrow('mention_not_in_text');
  });
});
