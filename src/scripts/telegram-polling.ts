import "dotenv/config";
import { dbConnect } from "../config/mongo";
import { handleUpdate } from "../services/lucas.service";
import {
  BOT_COMMANDS,
  callTelegram,
  deleteWebhook,
  getUpdates,
} from "../services/telegram.service";

/**
 * Lucas en local, sin URL pública: pide los updates a Telegram en vez de
 * esperar el webhook. Quita el webhook mientras corre; al desplegar hay que
 * volver a registrarlo con pnpm telegram:webhook.
 */
async function main() {
  await dbConnect();
  await deleteWebhook();
  await callTelegram("setMyCommands", { commands: BOT_COMMANDS });
  console.log("Lucas escuchando en modo polling. Ctrl+C para salir.");

  let offset = 0;
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update).catch((error) => console.error("[polling]", error));
      }
    } catch (error: any) {
      console.error("[polling]", error.message ?? error);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
