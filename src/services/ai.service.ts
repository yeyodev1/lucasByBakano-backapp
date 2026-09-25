import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { CLIENT_STAGES } from "../models/client.model";
import type { ClientDoc } from "./client.service";
import type { ConversationWithMessages } from "./conversation.service";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new CustomError(
      "Lucas no tiene cerebro todavía: falta ANTHROPIC_API_KEY en el .env",
      503,
    );
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface CaptureInput {
  images: { data: Buffer; mediaType: ImageMediaType }[];
  text?: string;
  // Pie de foto o texto del operador que acompaña la captura.
  hint?: string;
  operatorName: string;
}

export interface ExtractedConversation {
  isConversation: boolean;
  platform: string;
  client: {
    name: string;
    phone: string;
    email: string;
    company: string;
    username: string;
  };
  messages: { sender: "cliente" | "equipo"; senderName: string; text: string; time: string }[];
  operatorInstruction: string;
}

export interface Recommendation {
  clientIntent: string;
  summary: string;
  replies: { tone: string; text: string }[];
  nextStep: string;
  alerts: string[];
  suggestedStage: string;
  captured: { phone: string; email: string; company: string; interests: string[] };
}

export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// ─── Esquemas de salida ───────────────────────────────────────────────────────

const str = { type: "string" };

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isConversation", "platform", "client", "messages", "operatorInstruction"],
  properties: {
    isConversation: { type: "boolean" },
    platform: str,
    client: {
      type: "object",
      additionalProperties: false,
      required: ["name", "phone", "email", "company", "username"],
      properties: { name: str, phone: str, email: str, company: str, username: str },
    },
    messages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sender", "senderName", "text", "time"],
        properties: {
          sender: { type: "string", enum: ["cliente", "equipo"] },
          senderName: str,
          text: str,
          time: str,
        },
      },
    },
    operatorInstruction: str,
  },
};

const RECOMMENDATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "clientIntent",
    "summary",
    "replies",
    "nextStep",
    "alerts",
    "suggestedStage",
    "captured",
  ],
  properties: {
    clientIntent: str,
    summary: str,
    replies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tone", "text"],
        properties: { tone: str, text: str },
      },
    },
    nextStep: str,
    alerts: { type: "array", items: str },
    suggestedStage: { type: "string", enum: [...CLIENT_STAGES, ""] },
    captured: {
      type: "object",
      additionalProperties: false,
      required: ["phone", "email", "company", "interests"],
      properties: {
        phone: str,
        email: str,
        company: str,
        interests: { type: "array", items: str },
      },
    },
  },
};

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
- Escribes las respuestas listas para copiar y pegar en el chat: español neutro de Ecuador, cálido y directo, frases cortas, como escribe una persona por WhatsApp. Sin saludos repetidos si la conversación ya está en curso. Emojis con moderación y solo si el cliente los usa.
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

async function callStructured<T>(params: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}): Promise<{ data: T; usage: AiUsage }> {
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await getClient().beta.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      // Si el modelo declina por un falso positivo, la API reintenta con el modelo alterno recomendado.
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort: params.effort,
        format: { type: "json_schema", schema: params.schema },
      },
      system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: params.content }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new CustomError("La llave de Anthropic no es válida", 503);
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new CustomError("Lucas está saturado, intenta en un minuto", 429);
    }
    if (error instanceof Anthropic.APIError) {
      throw new CustomError(`Error de la IA (${error.status}): ${error.message}`, 502);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    throw new CustomError("La IA no quiso procesar esta conversación", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new CustomError("La conversación es demasiado larga para leerla de una vez", 422);
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new CustomError("La IA devolvió una respuesta ilegible", 502);
  }

  return {
    data,
    usage: {
      model: response.model,
      inputTokens:
        response.usage.input_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
    },
  };
}

// ─── Casos de uso ─────────────────────────────────────────────────────────────

/** Convierte capturas o texto pegado en mensajes ordenados + datos del cliente. */
export async function extractConversation(
  input: CaptureInput,
): Promise<{ data: ExtractedConversation; usage: AiUsage }> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = input.images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data.toString("base64") },
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

  return callStructured<ExtractedConversation>({
    system: EXTRACTION_SYSTEM.replace("{operator}", input.operatorName || "el operador"),
    content,
    schema: EXTRACTION_SCHEMA,
    // Transcribir no requiere razonar mucho; se prioriza la velocidad.
    effort: "low",
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

  return callStructured<Recommendation>({
    system: RECOMMENDATION_SYSTEM.replace(
      "{business}",
      input.business ||
        "Todavía no se configuró. No afirmes precios ni condiciones; pídelos entre corchetes y avisa en alerts que falta configurar /negocio.",
    ),
    content: [{ type: "text", text: sections.join("\n\n") }],
    schema: RECOMMENDATION_SCHEMA,
    effort: env.ANTHROPIC_EFFORT,
  });
}
