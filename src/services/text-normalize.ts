/**
 * Normalização textual compartilhada pelos filtros da triagem.
 *
 * Anúncios chegam com marcação HTML (`<p>`, `<br>`, `<strong>`...) e entidades
 * HTML (`&amp;`, `&nbsp;`, `&#39;`, `&ecirc;`...) que “colam” ou separam
 * palavras e impedem a correspondência por termo. Estas funções produzem uma
 * visão limpa do texto para a TRIAGEM, sem alterar a descrição original
 * armazenada na vaga: o relatório de auditoria e a análise com IA continuam
 * usando o texto original.
 */

// Entidades nomeadas mais frequentes nos anúncios (Latin-1 e pontuação usual).
// A busca é feita em minúsculas, cobrindo também as variantes maiúsculas.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: " ",
  bull: " ",
  middot: " ",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  aacute: "á",
  agrave: "à",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  igrave: "ì",
  icirc: "î",
  iuml: "ï",
  oacute: "ó",
  ograve: "ò",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  uacute: "ú",
  ugrave: "ù",
  ucirc: "û",
  uuml: "ü",
  ccedil: "ç",
  ntilde: "ñ",
  yacute: "ý",
  yuml: "ÿ",
  deg: "°",
  plusmn: "±",
};

/** Decodifica entidades HTML numéricas e as nomeadas conhecidas. */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
    (match, body: string) => {
      if (body.charAt(0) === "#") {
        const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
        const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);

        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
          return match;
        }

        return String.fromCodePoint(code);
      }

      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/**
 * Remove tags HTML e decodifica entidades, preservando o restante do texto.
 *
 * As tags viram espaços (para não unir palavras vizinhas); as entidades são
 * decodificadas em seguida, de modo que conteúdo escapado (ex.: `&lt;div&gt;`)
 * permaneça como texto visível, sem ser interpretado como marcação.
 */
export function stripHtml(text: string): string {
  if (!text) {
    return text;
  }

  const withoutTags = text.replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(withoutTags);
}
