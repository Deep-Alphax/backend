/**
 * Fronteiras de DIA em BRT (America/Sao_Paulo) para filtros sobre TIMESTAMPS REAIS
 * (createdAt / paymentDate / occurredAt).
 *
 * Contexto: timestamps são gravados em UTC. O usuário filtra por um DIA CIVIL escolhido
 * num seletor (ex.: "15/06"). Interpretar esse dia como meia-noite UTC desloca a janela
 * em 3h — uma compra das 22h BRT (= 01:00Z do dia seguinte) caía no dia errado. BRT é
 * UTC-3 FIXO desde 2019 (sem horário de verão), então a conversão é determinística.
 *
 * Aceita `'YYYY-MM-DD'` OU ISO completo: usa só a PARTE DA DATA. Isso é robusto ao fuso
 * do remetente para a audiência a OESTE de UTC (Brasil): a meia-noite local nunca recua
 * pro dia anterior em UTC, então a parte da data do ISO continua sendo o dia escolhido.
 *
 * NÃO usar para datas "wall-clock" do evento (eventDate/janelas/lotes) — essas são naïve
 * e seguem os helpers UTC; aqui é só para CORTAR intervalos de timestamps reais.
 */

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3

function brtDayPart(value: string | Date): string {
  const s = value instanceof Date ? value.toISOString() : String(value);
  return s.slice(0, 10); // YYYY-MM-DD
}

/** Início do dia BRT (00:00:00.000 BRT) como instante UTC — usar em `gte`. */
export function brtDayStartUtc(value: string | Date): Date {
  return new Date(Date.parse(`${brtDayPart(value)}T00:00:00.000Z`) + BRT_OFFSET_MS);
}

/** Fim INCLUSIVO do dia BRT (23:59:59.999 BRT) como instante UTC — usar em `lte`. */
export function brtDayEndUtc(value: string | Date): Date {
  return new Date(brtDayStartUtc(value).getTime() + 24 * 60 * 60 * 1000 - 1);
}

/**
 * Início (00:00 BRT, como instante UTC) do DIA BRT que CONTÉM o instante real dado.
 *
 * Diferente de `brtDayStartUtc(new Date())`: aquele lê a parte da data em UTC, então
 * entre 21:00–23:59 BRT (= 00:00–02:59Z do dia SEGUINTE) usaria o dia UTC errado —
 * "hoje" pularia pro amanhã. Aqui convertemos o instante pro wall-clock BRT (−3h)
 * ANTES de extrair o dia, então o "hoje" é sempre o dia civil de Brasília.
 */
export function brtDayStartUtcOfInstant(instant: Date = new Date()): Date {
  return brtDayStartUtc(new Date(instant.getTime() - BRT_OFFSET_MS));
}

/**
 * Janela WALL-CLOCK do evento (abertura/encerramento de inscrição, realização) é
 * gravada como UTC (server em UTC: `new Date("...09:30:00")` → 09:30Z = 09:30 BRT
 * pretendido). Para COMPARAR com o tempo real (`new Date()`), o instante real é o
 * wall-clock interpretado em BRT (UTC-3) → +3h sobre o valor UTC. Sem isso a janela
 * abre/fecha 3h CEDO no Brasil (ex.: "encerra 09:30" fechava às 06:30 BRT).
 */
export function eventWindowInstant(value: string | Date): Date {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getTime() + BRT_OFFSET_MS);
}
