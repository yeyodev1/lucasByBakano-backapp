import "dotenv/config";
import { deleteWebhook, setWebhook } from "../services/telegram.service";

/**
 * Registra el webhook de Lucas en Telegram y su menú de comandos.
 *
 *   pnpm telegram:webhook https://lucas-by-bakano-backapp.vercel.app
 *   pnpm telegram:webhook --delete
 */
async function main() {
  const arg = process.argv[2];

  if (arg === "--delete") {
    await deleteWebhook();
    console.log("Webhook eliminado.");
    return;
  }
  if (!arg?.startsWith("https://")) {
    console.error("Uso: pnpm telegram:webhook https://<dominio-del-backend>");
    process.exit(1);
  }

  const url = `${arg.replace(/\/$/, "")}/api/telegram/webhook`;
  await setWebhook(url);
  console.log(`Webhook registrado: ${url}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
