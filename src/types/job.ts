/**
 * Modalidade de trabalho informada de forma estruturada pela fonte.
 *
 * Campo auxiliar: `"unknown"` é usado quando a fonte traz um rótulo presente
 * porém não classificável. A ausência do campo também representa desconhecido.
 * O sinal booleano `Job.remote` continua sendo o usado pelo pipeline.
 */
export type JobWorkplaceType = "remote" | "hybrid" | "onsite" | "unknown";

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
   * Modalidade de trabalho estruturada informada pela fonte, quando disponível.
   * Preserva `remote` para compatibilidade com o pipeline; é informação
   * adicional, nunca inferida por ausência de sinal.
   */
  workplaceType?: JobWorkplaceType;
  /** Tipos de contratação informados pela fonte (ex.: "CLT", "Full-time"). */
  contractTypes?: string[];
  /** Localidades adicionais informadas pela fonte, quando existirem. */
  additionalLocations?: string[];
}
