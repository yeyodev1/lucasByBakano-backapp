import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import { User, IUser } from "../models/user.model";

const TOKEN_TTL = "30d";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  phone: string;
  accountType: string;
}

function sanitize(user: any): SessionUser {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    phone: user.phone,
    accountType: user.accountType,
  };
}

function signToken(user: any): string {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email, accountType: user.accountType },
    env.JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

function requireDb() {
  if (!isConnected()) throw new CustomError("El servidor no tiene base de datos disponible", 503);
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: SessionUser }> {
  requireDb();
  if (!email || !password) {
    throw new CustomError("Escribe tu correo y tu contraseña", 400);
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+password");

  // Mismo mensaje exista o no la cuenta: el login no sirve para descubrir correos.
  const invalido = new CustomError("Correo o contraseña incorrectos", 401);
  if (!user || !user.isActive) throw invalido;
  if (!(await bcrypt.compare(password, user.password))) throw invalido;

  user.lastLoginAt = new Date();
  await user.save();

  return { token: signToken(user), user: sanitize(user) };
}

export async function findById(id: string): Promise<SessionUser> {
  requireDb();
  const user = await User.findById(id);
  if (!user) throw new CustomError("Usuario no encontrado", 404);
  return sanitize(user);
}

export async function changePassword(
  id: string,
  current: string,
  next: string,
): Promise<SessionUser> {
  requireDb();
  if (next.length < 8) {
    throw new CustomError("La nueva contraseña debe tener al menos 8 caracteres", 400);
  }

  const user = await User.findById(id).select("+password");
  if (!user) throw new CustomError("Usuario no encontrado", 404);
  if (!(await bcrypt.compare(current, user.password))) {
    throw new CustomError("La contraseña actual no es correcta", 401);
  }

  user.password = next;
  await user.save();
  return sanitize(user);
}

export async function createUser(input: {
  email: string;
  password: string;
  name?: string;
  phone?: string;
  accountType?: IUser["accountType"];
}): Promise<SessionUser> {
  requireDb();
  const email = input.email.toLowerCase().trim();
  if (!EMAIL.test(email)) throw new CustomError("Correo inválido", 400);
  if (input.password.length < 8) {
    throw new CustomError("La contraseña debe tener al menos 8 caracteres", 400);
  }

  const user = await User.create({
    email,
    password: input.password,
    name: input.name || "",
    phone: input.phone || "",
    accountType: input.accountType || "customer",
  });
  return sanitize(user);
}

/**
 * Crea la cuenta de administración si todavía no existe.
 *
 * Las credenciales salen del entorno para no dejarlas escritas en el repo.
 * Si la cuenta ya está, no se toca: cambiar la contraseña desde acá borraría
 * una que se hubiera cambiado a mano.
 */
export async function seedAdmin(): Promise<void> {
  if (!isConnected()) return;

  if (!env.ADMIN_PASSWORD) {
    console.warn("[auth] ADMIN_PASSWORD no definida — no se crea la cuenta de administración");
    return;
  }

  try {
    const existing = await User.findOne({ email: env.ADMIN_EMAIL });
    if (existing) return;

    await User.create({
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      name: env.ADMIN_NAME,
      accountType: "admin",
    });
    console.log(`[auth] cuenta de administración creada: ${env.ADMIN_EMAIL}`);
  } catch (error) {
    console.error("[auth] no se pudo crear la cuenta de administración:", error);
  }
}
