import mongoose, { Schema } from "mongoose";

export const CLIENT_STAGES = [
  "lead",
  "contactado",
  "interesado",
  "propuesta",
  "negociacion",
  "cliente",
  "perdido",
] as const;
export type ClientStage = (typeof CLIENT_STAGES)[number];

export interface IClientNote {
  text: string;
  author: string;
  createdAt: Date;
}

/** Ficha del CRM. Es el contexto que Lucas lee para saber con quién habla. */
export interface IClient {
  name: string;
  // Para buscar sin tildes ni mayúsculas.
  searchName: string;
  phones: string[];
  email: string;
  company: string;
  telegramUserId: number | null;
  telegramUsername: string;
  stage: ClientStage;
  source: string;
  interests: string[];
  tags: string[];
  // Resumen vivo que Lucas actualiza después de cada análisis.
  summary: string;
  notes: IClientNote[];
  lastContactAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const noteSchema = new Schema<IClientNote>(
  {
    text: { type: String, required: true },
    author: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const clientSchema = new Schema<IClient>(
  {
    name: { type: String, required: true, trim: true },
    searchName: { type: String, default: "", index: true },
    phones: { type: [String], default: [], index: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    company: { type: String, default: "" },
    telegramUserId: { type: Number, default: null, index: true },
    telegramUsername: { type: String, default: "", lowercase: true, index: true },
    stage: { type: String, enum: CLIENT_STAGES, default: "lead" },
    source: { type: String, default: "" },
    interests: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    summary: { type: String, default: "" },
    notes: { type: [noteSchema], default: [] },
    lastContactAt: { type: Date, default: null },
  },
  { timestamps: true },
);

clientSchema.pre("save", function (next) {
  if (this.isModified("name")) this.searchName = normalizeName(this.name);
  next();
});

/** "José Pérez " → "jose perez". Se usa al guardar y al buscar. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Deja solo dígitos; los números de Ecuador se guardan con 593 al inicio. */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("09") && digits.length === 10) return `593${digits.slice(1)}`;
  return digits;
}

export const Client = mongoose.models.Client || mongoose.model<IClient>("Client", clientSchema);
