/** Plataformas de vagas suportadas. */
export type JobProvider = "greenhouse" | "lever";

/** Fonte de vagas de uma empresa em uma plataforma. */
export interface JobSource {
  provider: JobProvider;
  identifier: string;
}

/** Fontes validadas para o MVP 1.0. */
export const JOB_SOURCES: readonly JobSource[] = [
  { provider: "greenhouse", identifier: "stripe" },
  { provider: "lever", identifier: "Flex" },
];
