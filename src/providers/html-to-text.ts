/**
 * Entidades nomeadas mais comuns em descrições de vagas. Não é a lista
 * completa do padrão HTML: cobre acentuação/pontuação do português e os
 * símbolos que costumam aparecer no texto.
 */
const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ordm: "\u00BA",
  ordf: "\u00AA",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  ccedil: "ç",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  iacute: "í",
  icirc: "î",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  uacute: "ú",
  uuml: "ü",
  ntilde: "ñ",
  Aacute: "Á",
  Agrave: "À",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Ccedil: "Ç",
  Eacute: "É",
  Egrave: "È",
  Ecirc: "Ê",
  Iacute: "Í",
  Icirc: "Î",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Uacute: "Ú",
  Uuml: "Ü",
  Ntilde: "Ñ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "…",
  middot: "·",
  bull: "•",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  sect: "§",
  times: "×",
  divide: "÷",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

/**
 * Converte HTML bruto em texto simples.
 *
 * As etapas são aplicadas em sequência sobre a mesma string:
 * 1. tags de bloco viram quebra de linha;
 * 2. as demais tags são removidas;
 * 3. entidades nomeadas e numéricas são decodificadas;
 * 4. espaços e linhas vazias são normalizados.
 */
export function htmlToText(html: string): string {
  // 1. Tags de bloco viram `\n`. O padrão aceita atributos (`<br/>`,
  // `<br aria-hidden="true">`) e usa `\b` para não casar prefixos como `<pre>`.
  const withBreaks = html.replace(
    /<\s*\/?\s*(?:br|p|li|div|ul|ol|h[1-6]|tr|hr)\b[^>]*>/gi,
    "\n",
  );

  // 2. Remove as demais tags. Exige que o `<` seja seguido de letra, `/` ou
  // `!` (como uma tag de verdade começa), então um `<` solto em "salário < 5k"
  // não é engolido até o próximo `>`.
  const withoutTags = withBreaks.replace(/<[a-zA-Z/!][^>]*>/g, "");

  // 3. Decodifica entidades. A varredura é de passagem única, então um
  // `&amp;` resultante nunca é reinterpretado como nova entidade.
  const decoded = withoutTags.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        // Nulo e surrogates soltos são inválidos (quebram UTF-8 e o
        // PostgreSQL), então caem na mesma regra: devolve o texto original.
        const isSurrogate = code >= 0xd800 && code <= 0xdfff;
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || isSurrogate) {
          return match;
        }
        return String.fromCodePoint(code);
      }
      return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : match;
    },
  );

  // 4. Normaliza espaços: espaços repetidos e espaços nas bordas das linhas
  // somem, e não sobra mais de uma linha vazia seguida.
  return decoded
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
