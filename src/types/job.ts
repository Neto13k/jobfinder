export type WorkplaceType = "remote" | "hybrid" | "onsite" | "unknown";

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  description: string;
  url: string;
  source: string;
  publishedAt?: string;
  /**
   * Modalidade de trabalho normalizada. Cada provider é responsável por
   * converter o texto da sua fonte para um destes valores.
   *
   * `unknown` significa que o provider tentou inferir e não conseguiu; ausente
   * (undefined) significa que a fonte simplesmente não fornece o dado.
   *
   * Quando `workplaceType` estiver presente, `remote` deve ser derivado dele
   * (`true` apenas quando for "remote"), nunca preenchido de forma
   * independente, evitando que os dois campos discordem.
   */
  workplaceType?: WorkplaceType;
  /**
   * Tipos de contrato informados pela fonte (ex.: ["PJ"]). Mantidos como texto
   * bruto, pois cada fonte usa seu próprio vocabulário; a normalização é
   * responsabilidade de quem consumir o campo.
   */
  contractTypes?: string[];
}
