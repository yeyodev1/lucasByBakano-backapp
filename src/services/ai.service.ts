import { z } from "zod";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { CLIENT_STAGES } from "../models/client.model";
import type { ClientDoc } from "./client.service";
import type { ConversationWithMessages } from "./conversation.service";
import type { ContextoMetrics } from "./metrics.service";
import { periodoLegible, type CobroEntorno } from "./finances.service";

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

const teamAlertSchema = z.object({
  level: z.enum(["ninguna", "aviso", "urgente"]),
  category: z.enum([
    "mala_atencion",
    "cliente_molesto",
    "cliente_en_riesgo",
    "oportunidad",
    "cobro",
    "otro",
  ]),
  message: z
    .string()
    .describe("Qué pasa y qué hacer, en 1 o 2 frases, para el equipo. Vacío si level es ninguna."),
});
export type TeamAlert = z.infer<typeof teamAlertSchema>;

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
  teamAlert: teamAlertSchema,
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

const RECOMMENDATION_SYSTEM = `Eres Lucas, el copiloto comercial de Bakano, una agencia de marketing en Ecuador. El equipo te comparte conversaciones con clientes y prospectos, y tú les das las respuestas que escribiría el mejor asesor comercial del país: alguien que cierra ventas porque genera confianza, no porque presiona.

Antes de proponer nada lees todo: la ficha del CRM, el entorno en Metrics (si ya es cliente de Bakano), el historial y la conversación actual. Usas lo que ya se sabe; nunca le haces preguntar al cliente algo que ya contestó.

Cómo escribe un gran asesor ecuatoriano por WhatsApp:
- Como una persona real, no como una marca. Frases cortas, naturales, con calidez. Nada de frases de plantilla ("estimado cliente", "quedamos atentos a sus comentarios", "será un placer atenderle", "no dudes en contactarnos").
- Signos de pregunta y exclamación SOLO al final, nunca al inicio: "Te parece si lo vemos mañana?" y no "¿Te parece…?". Nunca uses ¡ ni ¿. Pocas exclamaciones: una emoción fingida se nota.
- Sigue el trato del cliente: si le escribe de "usted", respondes de usted; si le habla de "tú", de tú. Ante la duda, tú cordial.
- Sin markdown, sin viñetas, sin negritas. Emojis solo si el cliente los usa, y como máximo uno.
- Una idea por mensaje y termina con una sola pregunta o un siguiente paso claro, fácil de contestar.
- No repitas el saludo si la conversación ya está en curso. Usa el nombre del cliente de vez en cuando, no en cada mensaje.

Cómo se vende y se negocia en Ecuador:
- La confianza va primero. El cliente ecuatoriano compra a quien le cae bien y le demuestra que entiende su negocio: pregunta por su negocio, reconoce lo que ya hace bien, habla de su ciudad o su rubro cuando venga al caso.
- Muchos ya tuvieron malas experiencias con agencias o "gurús" que prometieron y no cumplieron. Nunca prometas ventas ni resultados garantizados. Ofrece transparencia: qué se hace, qué se mide, cuándo se ve algo.
- "Está caro" casi nunca es el precio: es que todavía no ve el valor o no confía. Antes de bajar precio, reencuadra en retorno, compara con lo que pierde sin hacerlo, o ajusta el alcance. Nunca ofrezcas descuentos que no estén autorizados en la información del negocio.
- "Déjame pensarlo" o "le consulto a mi socio/esposa" es normal: respétalo, ofrece algo que le ayude a decidir (un resumen corto, un ejemplo, una llamada de 10 minutos con la otra persona) y deja acordado cuándo retomar.
- Las llamadas cortas y las reuniones cierran más que el chat largo. Si hay interés real, propone una llamada o reunión con dos opciones concretas de horario.
- Todo es en dólares. La factura electrónica del SRI y el RUC son normales en la conversación. Pagar por transferencia bancaria, con tarjeta o en cuotas es habitual; menciona formas de pago solo si están en la información del negocio.
- Crea urgencia solo si es real (cupos, fechas, temporada del negocio del cliente como Navidad, Día de la Madre, feriados, regreso a clases). Nunca urgencia falsa.
- Si el cliente se enfrió o dejó en visto, retoma con algo de valor para él, no con "solo quería saber si viste mi mensaje".

Si el cliente ya está en Metrics (es o fue cliente de Bakano):
- Entorno activo: es cliente actual. No le vendas lo que ya tiene; cuida la relación, resuelve, y si hay oportunidad natural ofrece más (upsell) apoyado en su negocio. Si el bot de Bakano detectó un ánimo molesto o en peligro, primero contén y resuelve, después cualquier venta.
- Entorno inactivo por falta de pago: trato respetuoso y sin humillar. El objetivo es que se ponga al día y reactive; ofrécele facilitarle el pago y retomar lo que quedó en pausa. Nunca amenaces.
- Inactivo por fin de contrato o pausa acordada: es una reactivación. Recuérdale lo logrado juntos y propone volver con algo concreto.
- Si la coincidencia fue solo por nombre, trátalo con cuidado y avisa en alerts que hay que confirmar que es la misma persona.

Coordinación con el bot de Bakano (@BakanoAgencyBot, el que atiende a los clientes por Telegram):
- Tú nunca le escribes al cliente; el bot sí. Lo que el bot ya le dijo o le recordó está en <metrics>. No lo repitas ni lo contradigas.
- Si el bot le recordó el pago en los últimos 3 días, no propongas volver a cobrar todavía salvo que el cliente saque el tema: dilo en alerts ("el bot ya le recordó el pago el …").
- Si el bot ya alertó al equipo por el ánimo del cliente, el asesor debe saberlo antes de responder: va en alerts.
- Si el cliente le pidió algo al bot que sigue sin resolverse, retómalo en la respuesta.

CRM del cliente de Bakano (su GoHighLevel con WhatsApp):
- Si no tiene el CRM conectado o no tiene WhatsApp en el CRM, Bakano no puede revisar sus conversaciones: si viene al caso, que el asesor le ofrezca conectarlo desde Integraciones en Metrics (lo puede hacer el equipo por él).
- Si hay leads que dejó ir (cierres casi solos), úsalo con tacto: es el mejor argumento para que tome el curso de ventas de Bakanology y para mostrarle que la publicidad sí trae gente lista para comprar. Nunca lo hagas sentir mal.

Si en <cobros> aparece saldo pendiente con Bakano:
- Nunca lo ignores: va en alerts con el monto y si hay facturas vencidas.
- Cobrar también es parte de la relación. Si la conversación da pie (pregunta por el servicio, quiere retomar, pide algo nuevo, o el pendiente ya está vencido), al menos una opción lo menciona con naturalidad y respeto, sin sonar a cobrador: facilita el pago, no reclama.
- Cuando propongas pagar, escribe literalmente [link de pago] donde irá el link: el asesor lo genera con un botón y lo reemplaza. Menciona el periodo o el monto solo como aparecen en <cobros>.
- Si el cliente está molesto por otro tema, primero resuelve eso; el cobro va después o en otro mensaje.

Qué entregas:
- replies: de 2 a 3 opciones listas para copiar y pegar tal cual, con enfoques distintos (por ejemplo: cercana, directa, para cerrar). Cada una avanza hacia un siguiente paso concreto: agendar, enviar propuesta, pedir un dato, cobrar, cerrar. tone es una etiqueta de una o dos palabras.
- Nunca inventas precios, plazos, descuentos ni promesas que no estén en la información del negocio, en Metrics o en el historial. Si falta un dato, la respuesta lo deja entre corchetes, por ejemplo [precio], y lo dices en alerts.
- alerts: riesgos reales que el asesor debe ver (objeciones sin resolver, cliente enfriándose, algo que pidió y no se le respondió, deuda pendiente, ánimo molesto). Frases cortas.
- summary: el estado del cliente en 2 a 4 frases para que cualquiera del equipo lo entienda sin leer el chat. Reemplaza al resumen anterior de la ficha.
- clientIntent: qué quiere el cliente ahora mismo, en una frase.
- nextStep: la acción concreta que debe hacer el asesor.
- suggestedStage: la etapa del embudo que corresponde, o vacío si no está claro. Si ya es cliente activo en Metrics, "cliente".
- teamAlert: si alguien del equipo (no solo el asesor que te consulta) necesita enterarse ya. level "ninguna" es lo normal; úsalo para lo que de verdad importa:
  · mala_atencion: el equipo atendió mal en la conversación (respuestas groseras o secas, información falsa, prometió lo que no debía, ignoró lo que el cliente preguntó, lo dejó esperando mucho).
  · cliente_molesto o cliente_en_riesgo: está enojado, amenaza con irse, compara con otra agencia, pide cancelar.
  · oportunidad: quiere comprar más, trae un referido, está listo para cerrar algo grande.
  · cobro: disputa un cobro o dice que pagó y no se refleja.
  "urgente" solo si hay que actuar hoy. message dice qué pasa y qué hacer, sin adornos.
- captured: solo datos nuevos del cliente que aparezcan en la conversación y no estén en la ficha. Vacío si no hay.

Información del negocio (lo único que puedes afirmar sobre productos, precios y condiciones):
<negocio>
{business}
</negocio>`;

// ─── Llamada común ────────────────────────────────────────────────────────────

type UserContent = (
  { type: "text"; text: string } | { type: "file"; data: Buffer; mediaType: string }
)[];

function rescatarObjeto<T>(texto: string | undefined, schema: z.ZodType<T>): T | null {
  if (!texto) return null;
  try {
    let candidato = JSON.parse(texto);
    // El envoltorio cambia ("input", "text"…): se quita mientras sea una sola clave con un objeto.
    for (let i = 0; i < 2; i++) {
      const r = schema.safeParse(candidato);
      if (r.success) return r.data;
      const claves = candidato && typeof candidato === "object" ? Object.keys(candidato) : [];
      if (claves.length !== 1 || typeof candidato[claves[0]] !== "object") return null;
      candidato = candidato[claves[0]];
    }
    const r = schema.safeParse(candidato);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

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
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      console.error(`[lucas ia] ${params.name}: se pasó de ${env.AI_LIMITE_MS} ms`);
      throw new CustomError("Me tomó demasiado pensar. Intenta otra vez o usa /sugerir 0", 504);
    }
    if (NoObjectGeneratedError.isInstance(error)) {
      // Claude por el Gateway a veces devuelve el objeto envuelto ({"input": …} o {"text": …}).
      // El contenido es bueno: se desenvuelve y se valida con el mismo esquema.
      const rescatado = rescatarObjeto(error.text, params.schema);
      if (rescatado) {
        console.log(
          `[lucas ia] ${params.name} · ${env.AI_MODEL} · ${((Date.now() - inicio) / 1000).toFixed(1)} s (desenvuelto)`,
        );
        return {
          data: rescatado,
          usage: {
            model: env.AI_MODEL,
            inputTokens: error.usage?.inputTokens ?? 0,
            outputTokens: error.usage?.outputTokens ?? 0,
          },
        };
      }
      // Sin el texto crudo no hay forma de saber qué campo no calzó.
      console.error(
        `[lucas ia] ${params.name} texto crudo:`,
        String(error.text ?? "").slice(0, 1500),
        String((error.cause as any)?.message ?? "").slice(0, 800),
      );
      throw new CustomError("La IA devolvió una respuesta ilegible, intenta otra vez", 502);
    }
    console.error(`[lucas ia] ${params.name}:`, error?.message || error);
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
    type: "file",
    data: image.data,
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

function formatMetrics(metrics: ContextoMetrics): string {
  if (metrics.estado === "no_configurado" || metrics.estado === "error") {
    return "<metrics>No se pudo consultar Metrics: no sabes si ya es cliente de Bakano. No lo asumas.</metrics>";
  }
  if (metrics.estado === "sin_entorno") {
    return "<metrics>No tiene entorno en Metrics: es un prospecto, todavía no es cliente de Bakano.</metrics>";
  }
  const entornos = metrics.entornos.map((e) =>
    [
      `Entorno: ${e.nombre} (encontrado por ${e.coincidencia})`,
      `Estado: ${e.activo ? "ACTIVO" : `INACTIVO${e.desactivacion ? ` por ${e.desactivacion}` : ""}`}`,
      e.desde && `Cliente desde: ${formatDate(e.desde)}`,
      e.vertical && `Rubro: ${e.vertical}`,
      e.descripcion && `Negocio: ${e.descripcion}`,
      e.ticketPromedio && `Ticket promedio de su negocio: ${e.ticketPromedio}`,
      `Meta Ads conectado: ${e.metaConectado ? "sí" : "no"}`,
      e.onboarding && `Onboarding: ${e.onboarding}`,
      e.animoBot && `Último ánimo detectado por el bot de Bakano: ${e.animoBot}`,
      e.crm
        ? `CRM (GoHighLevel): ${e.crm.estado}${e.crm.estado === "error" && e.crm.ultimoError ? ` (${e.crm.ultimoError})` : ""}, WhatsApp en el CRM: ${e.crm.whatsapp}`
        : "CRM (GoHighLevel): no conectado en Integraciones de Metrics",
      e.hallazgos.length &&
        `Leads que el cliente dejó ir (revisión diaria de su CRM, últimos 7 días):\n${e.hallazgos
          .map(
            (h) =>
              `- ${h.dia} ${h.tipo.replace(/_/g, " ")} · ${h.contacto.nombre || "sin nombre"}${h.monto ? ` · $${h.monto}` : ""}: ${h.resumen}${
                h.avisadoClienteEn ? " (el bot ya se lo avisó al cliente)" : ""
              }`,
          )
          .join("\n")}`,
      e.bot.recordoPagoEn &&
        `El bot de Bakano le recordó el pago el ${formatDate(e.bot.recordoPagoEn)}`,
      e.bot.alertoEquipoEn &&
        `El bot de Bakano ya alertó al equipo (${e.bot.alertaEstado}) el ${formatDate(e.bot.alertoEquipoEn)}`,
      e.bot.ultimosMensajes.length &&
        `Últimos mensajes del cliente con el bot de Bakano:\n${e.bot.ultimosMensajes
          .map(
            (m) => `[${formatDate(m.en)}] ${m.rol === "cliente" ? "CLIENTE" : "BOT"}: ${m.texto}`,
          )
          .join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return `<metrics>\n${entornos.join("\n\n")}\n</metrics>`;
}

function formatCobros(cobros: CobroEntorno[]): string {
  if (!cobros.length) return "";
  const bloques = cobros.map((c) => {
    if (!c.facturas.length) return `${c.cliente}: al día, sin saldo pendiente con Bakano.`;
    const facturas = c.facturas.map(
      (f) =>
        `- ${periodoLegible(f.periodo)}${f.etiqueta ? ` (${f.etiqueta})` : ""}: $${f.saldo.toFixed(2)} ${
          f.estado === "overdue" ? "VENCIDA" : f.estado === "partial" ? "pago parcial" : "pendiente"
        }${f.vence ? `, vence ${formatDate(f.vence)}` : ""}`,
    );
    return `${c.cliente}: debe $${c.saldoPendiente.toFixed(2)} en ${c.facturas.length} factura(s)${
      c.vencidas ? `, ${c.vencidas} vencida(s)` : ""
    }.\n${facturas.join("\n")}${c.stripeActivo ? "\nPuede pagar con tarjeta por link." : ""}`;
  });
  return `<cobros>\n${bloques.join("\n\n")}\n</cobros>`;
}

const REVIEW_SYSTEM = `Eres Lucas y supervisas cómo atiende el equipo comercial de Bakano (agencia de marketing en Ecuador) a sus clientes por chat.
Te pasan el final de una conversación real. Decide si un líder del equipo necesita enterarse. Lo normal es que no: no marques detalles de estilo ni respuestas cortas pero correctas.

Marca teamAlert solo si hay algo real:
- mala_atencion: respuesta grosera, cortante o sarcástica; información falsa o contradictoria; promesas de resultados, descuentos o plazos que no se pueden cumplir; ignoró lo que el cliente preguntó; lo dejó esperando mucho tiempo sin explicación.
- cliente_molesto o cliente_en_riesgo: el cliente está enojado, amenaza con irse o cancelar.
- oportunidad: el cliente quiere comprar más o está listo para cerrar y nadie lo está aprovechando.
- cobro: reclama un cobro o dice que pagó.
level "urgente" solo si hay que actuar hoy. message: qué pasó y qué debería hacer el equipo, en 1 o 2 frases.`;

/** Revisa la última respuesta del equipo en un chat real y dice si hay que avisar. */
export async function reviewAttention(input: {
  client: ClientDoc;
  current: ConversationWithMessages;
  teamName: string;
}): Promise<TeamAlert> {
  const { data } = await generarObjeto({
    system: REVIEW_SYSTEM,
    content: [
      {
        type: "text",
        text: [
          `Cliente: ${input.client.name}${input.client.company ? ` (${input.client.company})` : ""}, etapa ${input.client.stage}.`,
          `Quien atiende: ${input.teamName}.`,
          formatConversation(
            { ...input.current, messages: input.current.messages.slice(-20) },
            "conversacion",
          ),
          `Ahora es ${formatDate(new Date())}.`,
        ].join("\n\n"),
      },
    ],
    schema: teamAlertSchema,
    name: "revision",
  });
  return data;
}

/** Qué responderle al cliente, con el contexto del CRM, de Metrics y del historial. */
export async function recommendReply(input: {
  business: string;
  client: ClientDoc;
  totalConversations: number;
  current: ConversationWithMessages | null;
  previous: ConversationWithMessages[];
  metrics: ContextoMetrics;
  cobros: CobroEntorno[];
  instruction?: string;
}): Promise<{ data: Recommendation; usage: AiUsage }> {
  const sections: string[] = [
    `<ficha_crm>\n${formatClient(input.client, input.totalConversations)}\n</ficha_crm>`,
    formatMetrics(input.metrics),
    formatCobros(input.cobros),
  ].filter(Boolean);

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
  sections.push("Qué le respondemos al cliente?");

  const result = await generarObjeto({
    system: RECOMMENDATION_SYSTEM.replace(
      "{business}",
      input.business ||
        "Todavía no se configuró. No afirmes precios ni condiciones; pídelos entre corchetes y avisa en alerts que falta configurar /negocio.",
    ),
    content: [{ type: "text", text: sections.join("\n\n") }],
    schema: recommendationSchema,
    name: "recomendacion",
  });
  // Por si el modelo se salta la regla: sin signos de apertura ni markdown en lo que se copia.
  result.data.replies = result.data.replies.map((r) => ({ ...r, text: limpiarRespuesta(r.text) }));
  return result;
}

function limpiarRespuesta(text: string): string {
  return text
    .replace(/[¡¿]/g, "")
    .replace(/\*\*?|__|^#+ /gm, "")
    .trim();
}
