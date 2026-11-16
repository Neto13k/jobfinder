// Teste de integração do envio ao Telegram, feito para o GitHub Actions.
//
// Uso:   npm run build
//        node scripts/telegram-smoke.mjs
//
// Envia UMA única mensagem fictícia ao chat configurado, claramente
// identificada como teste técnico. Reutiliza sendJobNotification do módulo
// compilado, sem duplicar a lógica HTTP.
//
// Isolamento: não consulta o Gemini, não acessa o PostgreSQL/Supabase, não
// lê nem grava históricos, não altera notificações e não usa src/index.ts.
// Credenciais vêm exclusivamente de TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID.
//
// Encerra com código diferente de zero se o envio falhar.

// Importa apenas o módulo do Telegram (sem tocar em persistência ou IA).
const { sendJobNotification } = await import("../dist/services/telegram.js");

// Vaga fictícia: o título deixa explícito que é um teste, não uma vaga real.
const testJob = {
  id: "telegram-smoke-001",
  title: "TESTE — JobFinder GitHub Actions",
  company: "Teste técnico (não é uma vaga real)",
  location: "N/A — teste de integração",
  remote: false,
  description: "Mensagem fictícia usada apenas para validar o envio ao Telegram.",
  url: "https://example.com/telegram-smoke",
  source: "telegram-smoke",
};

// Análise fictícia, apenas para preencher o template existente da mensagem.
const testAnalysis = {
  decision: "review",
  score: 0,
  reason:
    "Teste técnico de integração do GitHub Actions. " +
    "Esta NÃO é uma oportunidade real de emprego.",
  locationStatus: "unknown",
  contractStatus: "unknown",
};

try {
  await sendJobNotification(testJob, testAnalysis);
  console.log("Envio de teste ao Telegram concluído com sucesso.");
} catch (error) {
  // Nunca expõe credenciais: apenas a mensagem do erro.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[telegram-smoke] Falha no envio: ${message}`);
  process.exitCode = 1;
}
