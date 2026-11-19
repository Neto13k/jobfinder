import type { JobWorkplaceType } from "../types/job.js";

/**
 * Normaliza o rótulo de modalidade de trabalho de uma fonte para o contrato
 * estruturado {@link JobWorkplaceType}.
 *
 * Reconhece as grafias usadas pelos providers (ex.: "Remote", "on-site",
 * "Hybrid", "In-office", "presencial", "híbrido"). O rótulo é normalizado com
 * NFD e sem marcas diacríticas, aceitando formas acentuadas e não acentuadas.
 * Um rótulo presente porém não reconhecido vira `"unknown"` (a fonte informou
 * algo, mas não classificável); rótulo ausente ou inválido retorna `undefined`
 * para não inventar modalidade.
 *
 * @param value Rótulo bruto da fonte (pode ser qualquer tipo).
 * @returns A modalidade estruturada, `"unknown"` ou `undefined` quando ausente.
 */
export function toWorkplaceType(value: unknown): JobWorkplaceType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  if (normalized === "") {
    return undefined;
  }

  switch (normalized) {
    case "remote":
    case "remoto":
    case "remota":
      return "remote";
    case "hybrid":
    case "hibrido":
    case "hibrida":
      return "hybrid";
    case "onsite":
    case "presencial":
    case "inoffice":
      return "onsite";
    default:
      return "unknown";
  }
}

/**
 * Extrai uma lista de strings não vazias de um valor de tipo desconhecido.
 *
 * Ignora itens de outros tipos, remove espaços das bordas e elimina duplicatas.
 * Usado para campos estruturados (tipos de contratação, localidades) sem
 * inventar valores quando a fonte não os fornece.
 *
 * @param value Valor bruto da fonte (esperado como array de strings).
 * @returns Lista normalizada; vazia quando o valor não for um array de strings.
 */
export function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();

    if (trimmed === "" || result.includes(trimmed)) {
      continue;
    }

    result.push(trimmed);
  }

  return result;
}
