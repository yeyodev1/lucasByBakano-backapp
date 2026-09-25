import { z } from "zod";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { CLIENT_STAGES } from "../models/client.model";
import type { ClientDoc } from "./client.service";
import type { ConversationWithMessages } from "./conversation.service";

/**
 * La IA de Lucas corre con el AI SDK sobre Vercel AI Gateway, igual que el bot
 * de métricas: el modelo es un string "proveedor/modelo" (AI_MODEL) y se
 * autentica con AI_GATEWAY_API_KEY (u OIDC en Vercel). Cambiar de modelo es
 * cambiar AI_MODEL, sin tocar código.
 *
 * `ai` es solo ESM y se carga al primer uso, no al importar: si no carga en el
 * runtime, falla solo la IA y no la función entera de la API.
 */

type AiSdk = typeof import("ai");

let aiSdk: Promise<AiSdk> | null = null;
/**
 * `import()` a secas lo compila TypeScript a `require()` (module commonjs) y en
 * Vercel revienta con "require() of ES Module". El Function lo esconde del
 * compilador, así que sigue siendo un import dinámico de verdad.
 */
const importarEsm = new Function("modulo", "return import(modulo)") as (
  modulo: string,
) => Promise<any>;

async function traerAi(): Promise<AiSdk> {
  try {
    // El require literal es además lo que hace que Vercel empaquete "ai".
    return require("ai") as AiSdk;
  } catch (error: any) {
    if (error?.code !== "ERR_REQUIRE_ESM" && !/ES Module/i.test(String(error?.message))) {
      throw error;
    }
    return (await importarEsm("ai")) as AiSdk;
  }
}

function cargarAi(): Promise<AiSdk> {
  aiSdk ??= traerAi().catch((error) => {
    aiSdk = null;
    throw error;
  });
  return aiSdk;
}

export interface CaptureInput {
  images: { data: Buffer; mediaType: string }[];
  text?: string;
  // Pie de foto o texto del operador que acompaña la captura.
  hint?: string;
  operatorName: string;
}

export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// ─── Esquemas de salida ───────────────────────────────────────────────────────

const extractionSchema = z.object({
  isConversation: z.boolean(),
  platform: z
    .string()
    .describe("WhatsApp, Instagram, Telegram, Messenger, correo, etc. Vacío si no se sabe."),
  client: z.object({
    name: z.string(),
    phone: z.string(),
    email: z.string(),
    company: z.string(),
    username: z.string(),
  }),
  messages: z.array(
    z.object({
      sender: z.enum(["cliente", "equipo"]),
      senderName: z.string(),
      text: z.string(),
      time: z.string(),
    }),
  ),
  operatorInstruction: z.string(),
});
export type ExtractedConversation = z.infer<typeof extractionSchema>;

const recommendationSchema = z.object({
  clientIntent: z.string(),
  summary: z.string(),
  replies: z.array(z.object({ tone: z.string(), text: z.string() })),
  nextStep: z.string(),
  alerts: z.array(z.string()),
  suggestedStage: z.enum([...CLIENT_STAGES, ""]),
  captured: z.object({
    phone: z.string(),
    email: z.string(),
    company: z.string(),
    interests: z.array(z.string()),
  }),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

// ─── Prompts ──────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `Eres el lector de conversaciones de Lucas, el asistente comercial de un equipo en Ecuador.
Recibes capturas de pantalla de chats (WhatsApp, Instagram, Telegram, Messenger, correo) o texto pegado, y opcionalmente una nota del operador.

Tu trabajo es transcribir, no interpretar:
- Transcribe cada mensaje visible en orden, tal como está escrito. No resumas ni corrijas.
- "equipo" es quien atiende (en WhatsApp suelen ser las burbujas verdes o a la derecha; el operador se llama {operator}). "cliente" es la otra persona.
- Del cliente saca lo que se vea: nombre del contacto en la cabecera, teléfono, correo, empresa, @usuario. Lo que no se vea queda como cadena vacía; no inventes.
- "time" es la hora o fecha visible del mensaje, o vacío.
- La nota del operador puede decir quién es el cliente ("es María de Construmia") o pedir algo ("quiere descuento, qué le digo"). Lo que sea un pedido va en operatorInstruction; los datos del cliente van en client.
- Si no hay ninguna conversación (por ejemplo el operador solo escribió una pregunta), isConversation es false y messages va vacío.`;

const RECOMMENDATION_SYSTEM = `Eres Lucas, el copiloto comercial de un equipo en Ecuador. El equipo te comparte conversaciones con sus clientes y tú les dices qué responder.

Cómo recomiendas:
- Lees la ficha del CRM, el historial y la conversación actual antes de proponer nada. Usa lo que ya se sabe del cliente; no le hagas preguntar al cliente algo que ya dijo.
- Escribes las respuestas listas para copiar y pegar en el chat: español neutro de Ecuador, cálido y directo, frases cortas, como escribe una persona por WhatsApp. Sin saludos repetidos si la conversación ya está en curso. Emojis con moderación y solo si el cliente los usa. Sin markdown.
- Das de 2 a 3 opciones con tonos distintos (por ejemplo: cercana, directa, para cerrar). Cada una avanza la venta hacia un siguiente paso concreto: agendar, enviar propuesta, pedir un dato, cerrar.
- Nunca inventas precios, plazos, descuentos ni promesas que no estén en la información del negocio o en el historial. Si hace falta un dato que no tienes, la respuesta lo pide o lo deja entre corchetes, por ejemplo [precio], y lo mencionas en alerts.
- En alerts señalas riesgos: objeciones sin resolver, el cliente se está enfriando, pidió algo que no se le respondió, mensajes sin contestar hace días.
- summary es el estado actual del cliente en 2 a 4 frases, pensado para que cualquiera del equipo lo entienda sin leer el chat. Reemplaza al resumen anterior de la ficha.
- clientIntent es qué quiere el cliente ahora mismo, en una frase.
- suggestedStage es la etapa del embudo que corresponde según la conversación, o vacío si no está claro.
- En captured pones solo datos nuevos del cliente que aparezcan en la conversación y no estén ya en la ficha. Vacío si no hay.

Información del negocio (lo único que puedes afirmar sobre productos, precios y condiciones):
<negocio>
{business}
</negocio>`;

// ─── Llamada común ────────────────────────────────────────────────────────────

type UserContent = (
  { type: "text"; text: string } | { type: "image"; image: Buffer; mediaType: string }
)[];

async function generarObjeto<T>(params: {
  system: string;
  content: UserContent;
  schema: z.ZodType<T>;
  name: string;
}): Promise<{ data: T; usage: AiUsage }> {
  if (!env.AI_GATEWAY_API_KEY && !env.IS_VERCEL) {
    throw new CustomError(
      "Lucas no tiene cerebro todavía: falta AI_GATEWAY_API_KEY en el .env",
      503,
    );
  }

  const { generateText, Output, NoObjectGeneratedError } = await cargarAi();
  const inicio = Date.now();

  try {
    const result = await generateText({
      model: env.AI_MODEL,
      system: params.system,
      messages: [{ role: "user", content: params.content }],
      output: Output.object({ schema: params.schema, name: params.name }),
      abortSignal: AbortSignal.timeout(env.AI_LIMITE_MS),
    });
    console.log(
      `[lucas ia] ${params.name} · ${env.AI_MODEL} · ${((Date.now() - inicio) / 1000).toFixed(1)} s`,
    );
    return {
      data: result.output as T,
      usage: {
        model: env.AI_MODEL,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
    };
  } catch (error: any) {
    console.error(`[lucas ia] ${params.name}:`, error?.message || error);
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new CustomError("Me tomó demasiado pensar. Intenta otra vez o usa /sugerir 0", 504);
    }
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new CustomError("La IA devolvió una respuesta ilegible, intenta otra vez", 502);
    }
    const status = error?.statusCode ?? error?.status;
    if (status === 401 || status === 403) {
      throw new CustomError("La llave de AI Gateway no es válida", 503);
    }
    if (status === 402) throw new CustomError("AI Gateway se quedó sin crédito", 503);
    if (status === 429) throw new CustomError("Lucas está saturado, intenta en un minuto", 429);
    throw new CustomError("No pude pensar la respuesta, intenta otra vez", 502);
  }
}

// ─── Casos de uso ─────────────────────────────────────────────────────────────

/** Convierte capturas o texto pegado en mensajes ordenados + datos del cliente. */
export async function extractConversation(
  input: CaptureInput,
): Promise<{ data: ExtractedConversation; usage: AiUsage }> {
  const content: UserContent = input.images.map((image) => ({
    type: "image",
    image: image.data,
    mediaType: image.mediaType,
  }));

  const parts: string[] = [];
  if (input.text) parts.push(`<conversacion_pegada>\n${input.text}\n</conversacion_pegada>`);
  if (input.hint) parts.push(`<nota_del_operador>\n${input.hint}\n</nota_del_operador>`);
  parts.push(
    input.images.length
      ? "Transcribe la conversación de las capturas."
      : "Transcribe la conversación del texto, si la hay.",
  );
  content.push({ type: "text", text: parts.join("\n\n") });

  return generarObjeto({
    system: EXTRACTION_SYSTEM.replace("{operator}", input.operatorName || "el operador"),
    content,
    schema: extractionSchema,
    name: "conversacion",
  });
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleString("es-EC", {
    timeZone: "America/Guayaquil",
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatConversation(item: ConversationWithMessages, title: string): string {
  const lines = item.messages.map(
    (m) =>
      `[${formatDate(m.sentAt)}] ${m.sender === "cliente" ? "CLIENTE" : "EQUIPO"}${
        m.senderName ? ` (${m.senderName})` : ""
      }: ${m.text}`,
  );
  return `<${title} canal="${item.conversation.channel}" inicio="${formatDate(
    item.conversation.startedAt,
  )}">\n${lines.join("\n")}\n</${title}>`;
}

function formatClient(client: ClientDoc, totalConversations: number): string {
  const notes = client.notes
    .slice(-10)
    .map((n) => `- ${formatDate(n.createdAt)} ${n.author ? `(${n.author}) ` : ""}${n.text}`)
    .join("\n");
  return [
    `Nombre: ${client.name}`,
    client.company && `Empresa: ${client.company}`,
    client.phones.length && `Teléfonos: ${client.phones.join(", ")}`,
    client.email && `Correo: ${client.email}`,
    `Etapa en el embudo: ${client.stage}`,
    client.source && `Origen: ${client.source}`,
    client.interests.length && `Intereses: ${client.interests.join(", ")}`,
    client.tags.length && `Etiquetas: ${client.tags.join(", ")}`,
    `Conversaciones registradas: ${totalConversations}`,
    client.lastContactAt && `Último contacto: ${formatDate(client.lastContactAt)}`,
    client.summary && `Resumen previo: ${client.summary}`,
    notes && `Notas del equipo:\n${notes}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Qué responderle al cliente, con el contexto del CRM y del historial. */
export async function recommendReply(input: {
  business: string;
  client: ClientDoc;
  totalConversations: number;
  current: ConversationWithMessages | null;
  previous: ConversationWithMessages[];
  instruction?: string;
}): Promise<{ data: Recommendation; usage: AiUsage }> {
  const sections: string[] = [
    `<ficha_crm>\n${formatClient(input.client, input.totalConversations)}\n</ficha_crm>`,
  ];

  if (input.previous.length) {
    sections.push(
      `<historial>\n${input.previous
        .map((c, i) => formatConversation(c, `conversacion_anterior_${i + 1}`))
        .join("\n\n")}\n</historial>`,
    );
  }
  sections.push(
    input.current
      ? formatConversation(input.current, "conversacion_actual")
      : "<conversacion_actual>Todavía no hay mensajes registrados con este cliente.</conversacion_actual>",
  );
  sections.push(`Ahora es ${formatDate(new Date())} (hora de Ecuador).`);
  if (input.instruction) {
    sections.push(`<pedido_del_operador>\n${input.instruction}\n</pedido_del_operador>`);
  }
  sections.push("¿Qué le respondemos al cliente?");

  return generarObjeto({
    system: RECOMMENDATION_SYSTEM.replace(
      "{business}",
      input.business ||
        "Todavía no se configuró. No afirmes precios ni condiciones; pídelos entre corchetes y avisa en alerts que falta configurar /negocio.",
    ),
    content: [{ type: "text", text: sections.join("\n\n") }],
    schema: recommendationSchema,
    name: "recomendacion",
  });
}
