/**
 * Seed script — crea (o actualiza) la cuenta de administrador desde .env.
 * Uso: pnpm seed:admin
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env";
import { User } from "../models/user.model";

async function main() {
  if (!env.ADMIN_PASSWORD) {
    console.error("✖ ADMIN_PASSWORD no está definida en .env");
    process.exit(1);
  }

  console.log("Conectando a MongoDB...");
  await mongoose.connect(env.DB_URI);

  const existing = await User.findOne({ email: env.ADMIN_EMAIL }).select("+password");

  if (existing) {
    existing.password = env.ADMIN_PASSWORD;
    existing.accountType = "admin";
    existing.name = env.ADMIN_NAME;
    existing.isActive = true;
    await existing.save();
    console.log(`✔ Cuenta admin actualizada: ${env.ADMIN_EMAIL}`);
  } else {
    await User.create({
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      name: env.ADMIN_NAME,
      accountType: "admin",
    });
    console.log(`✔ Cuenta admin creada: ${env.ADMIN_EMAIL}`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("✖ Falló el seed:", error);
  process.exit(1);
});
