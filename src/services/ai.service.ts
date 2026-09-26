import { z } from "zod";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { CLIENT_STAGES } from "../models/client.model";
import type { ClientDoc } from "./client.service";
import type { ConversationWithMessages } from "./conversation.service";
import type { ContextoNegocio } from "./negocio.service";

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
    .describe(
      "Qué pasa y qué hacer, en 1 o 2 frases, para el dueño del negocio. Vacío si level es ninguna.",
    ),
});
export type TeamAlert = z.infer<typeof teamAlertSchema>;

export const TEMPERATURAS = ["frio", "tibio", "caliente", "listo_para_pagar"] as const;

const recommendationSchema = z.object({
  clientIntent: z.string(),
  summary: z.string(),
  cierre: z.object({
    probabilidad: z.number().describe("0 a 100: qué tan probable es cerrar esta venta ahora"),
    temperatura: z.enum(TEMPERATURAS),
    porQue: z.string().describe("Las señales que te llevan a ese número, en una frase"),
    falta: z
      .array(z.string())
      .describe("Lo que falta para cerrar: datos, objeciones, confirmaciones. Vacío si nada."),
  }),
  pago: z.object({
    enviarAhora: z
      .boolean()
      .describe("true si ya es momento de mandarle los datos de pago o el link"),
    porQue: z.string(),
    mensaje: z
      .string()
      .describe("Si enviarAhora, el mensaje listo con los datos de pago del negocio; si no, vacío"),
  }),
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

const EXTRACTION_SYSTEM = `Eres el lector de conversaciones de Lucas, el agente de ventas de negocios en Ecuador que venden por WhatsApp.
Recibes capturas de pantalla de chats (WhatsApp, Instagram, Telegram, Messenger, correo) o texto pegado, y opcionalmente una nota del operador.

Tu trabajo es transcribir, no interpretar:
- Transcribe cada mensaje visible en orden, tal como está escrito. No resumas ni corrijas.
- "equipo" es el negocio, quien vende (en WhatsApp suelen ser las burbujas verdes o a la derecha; quien te escribe se llama {operator}). "cliente" es el interesado que quiere comprar.
- Del cliente saca lo que se vea: nombre del contacto en la cabecera, teléfono, correo, empresa, @usuario. Lo que no se vea queda como cadena vacía; no inventes.
- "time" es la hora o fecha visible del mensaje, o vacío.
- La nota del operador puede decir quién es el cliente ("es María de Construmia") o pedir algo ("quiere descuento, qué le digo"). Lo que sea un pedido va en operatorInstruction; los datos del cliente van en client.
- Si no hay ninguna conversación (por ejemplo el operador solo escribió una pregunta), isConversation es false y messages va vacío.`;

const RECOMMENDATION_SYSTEM = `Eres Lucas, el agente de ventas que Bakano le da a sus clientes: negocios en Ecuador que venden por WhatsApp. El dueño o su vendedor te pasa la conversación con un interesado (el lead) y tú le dices exactamente qué responder para cerrar la venta, qué tan cerca está de cerrarla y cuándo mandarle el pago. Escribes como el mejor vendedor del país: cierra porque genera confianza y hace fácil comprar, no porque presiona.

Antes de proponer nada lees todo: la información del negocio, sus reglas de venta, sus datos de pago, la ficha del lead, el historial y la conversación actual. Usas lo que ya se sabe; nunca le haces preguntar al lead algo que ya dijo.

Reglas del negocio:
- Las reglas que aparecen en <reglas> se cumplen siempre, sin excepción. Si el lead pide algo que una regla no permite (por ejemplo una proforma por un monto menor al mínimo), la respuesta lo resuelve con amabilidad y le ofrece la alternativa que sí se puede (el precio por el chat, el link de pago, pasar a la tienda) sin sonar a "no se puede".
- Nunca inventes precios, productos, stock, plazos de entrega, descuentos ni promesas que no estén en la información del negocio o en la conversación. Si falta un dato, la respuesta lo deja entre corchetes, por ejemplo [precio], y lo dices en alerts.

Cómo escribe un gran vendedor ecuatoriano por WhatsApp:
- Como una persona real, no como una marca. Frases cortas, naturales, con calidez. Nada de frases de plantilla ("estimado cliente", "quedamos atentos", "será un placer atenderle").
- Signos de pregunta y exclamación SOLO al final, nunca al inicio: "Te lo separo para el sábado?" y no "¿Te lo separo…?". Nunca uses ¡ ni ¿. Pocas exclamaciones.
- Sigue el trato del lead: si escribe de "usted", respondes de usted; si de "tú", de tú. Ante la duda, tú cordial.
- Sin markdown ni viñetas. Emojis solo si el lead los usa, máximo uno.
- Una idea por mensaje y termina con una sola pregunta fácil de contestar o un siguiente paso claro.

Cómo se cierra una venta por WhatsApp en Ecuador:
- Responde lo que el lead preguntó primero, directo. Si pregunta el precio, dale el precio (si lo tienes) con el valor al lado, no lo escondas.
- Confirma lo que quiere con sus propias palabras (producto, cantidad, fecha, ciudad o entrega) y lleva la conversación a la decisión.
- "Está caro": reencuadra en valor, ofrece una opción más chica o en cuotas si el negocio lo permite; nunca inventes descuentos.
- "Déjame pensarlo" o "le consulto a mi esposa/socio": respétalo, dale algo que le ayude a decidir y deja acordado cuándo retomar.
- Urgencia solo si es real (stock, fecha de entrega, temporada: Navidad, Día de la Madre, feriados, regreso a clases).
- Si el lead se enfrió o dejó en visto, retoma con algo de valor, no con "solo quería saber si viste mi mensaje".
- Todo es en dólares. Transferencia, depósito, tarjeta, pago contra entrega, Payphone o De Una son normales; ofrece solo las formas de pago que el negocio tenga en <datos_pago>.

Qué tan cerca está de cerrar (cierre):
- frio (0-25): curiosea, no dio datos, preguntas genéricas.
- tibio (26-55): interés real, pregunta precio o detalles, todavía sin decidir.
- caliente (56-85): ya dijo qué quiere y para cuándo, o está resolviendo la última objeción.
- listo_para_pagar (86-100): confirmó producto y condiciones, pregunta cómo pagar o dónde depositar, o dice "lo quiero".
- falta: lo concreto que todavía no está (dirección de entrega, talla, confirmar fecha, resolver el precio...).

Cuándo mandar el pago (pago):
- enviarAhora es true cuando el lead ya confirmó qué quiere y el precio no está en discusión, o cuando él mismo pregunta cómo pagar. Mandar los datos de pago antes de eso enfría la venta; tardar cuando ya está listo la pierde.
- Si enviarAhora, mensaje es el texto listo para mandar: confirma el pedido y el total en una línea y pega los datos de <datos_pago> tal cual. Si no hay datos de pago configurados, deja [datos de pago] y avísalo en alerts. Además, al menos una de las replies debe cerrar pidiendo el pago.

Qué entregas:
- replies: de 2 a 3 opciones listas para copiar y pegar tal cual, con enfoques distintos (por ejemplo: cercana, directa, para cerrar). tone es una etiqueta de una o dos palabras.
- clientIntent: qué quiere el lead ahora mismo, en una frase.
- summary: el estado de esta venta en 2 a 4 frases. Reemplaza al resumen anterior de la ficha.
- nextStep: la acción concreta que debe hacer quien vende ahora.
- alerts: riesgos reales (objeción sin resolver, lead enfriándose, algo que pidió y no se le respondió, dato que falta en la información del negocio). Frases cortas.
- suggestedStage: la etapa del embudo que corresponde, o vacío si no está claro.
- captured: solo datos nuevos del lead (teléfono, correo, empresa, intereses) que aparezcan en la conversación y no estén en la ficha.
- teamAlert: si el dueño del negocio necesita enterarse ya. Lo normal es "ninguna". Úsalo para: mala_atencion (quien atiende respondió seco, tarde, con información falsa o ignoró lo que el lead preguntó), cliente_molesto o cliente_en_riesgo (reclamo fuerte, amenaza con irse o con dejar mala reseña), oportunidad (compra grande, pedido recurrente, referido), cobro (dice que ya pagó y no se refleja). "urgente" solo si hay que actuar hoy.`;

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
      `[${formatDate(m.sentAt)}] ${m.sender === "cliente" ? "LEAD" : "NEGOCIO"}${
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

function formatNegocio(ctx: ContextoNegocio): string {
  const { negocio, perfil } = ctx;
  const partes: string[] = [`Nombre: ${negocio.nombre}`];
  if (perfil) {
    const p = perfil;
    [
      p.tipoNegocio &&
        `Tipo: ${p.tipoNegocio === "PRODUCTOS" ? "vende productos" : p.tipoNegocio === "SERVICIOS" ? "vende servicios" : p.tipoNegocio}`,
      p.vertical && `Rubro: ${p.vertical}`,
      p.descripcion && `Qué es: ${p.descripcion}`,
      p.productosServicios && `Productos o servicios: ${p.productosServicios}`,
      p.propuestaValor && `Propuesta de valor: ${p.propuestaValor}`,
      p.publicoObjetivo && `A quién le vende: ${p.publicoObjetivo}`,
      p.problemaResuelto && `Qué problema resuelve: ${p.problemaResuelto}`,
      p.porQueTeCompran && `Por qué le compran: ${p.porQueTeCompran}`,
      p.ticketPromedio && `Ticket promedio: ${p.ticketPromedio}`,
      p.tono && `Tono de la marca: ${p.tono}`,
    ]
      .filter(Boolean)
      .forEach((l) => partes.push(l as string));
  }
  if (negocio.info) partes.push(`Lo que el negocio le contó a Lucas:\n${negocio.info}`);
  if (partes.length === 1) {
    partes.push(
      "Todavía no hay información de productos ni precios: no afirmes ninguno, déjalos entre corchetes y avisa en alerts que falta configurar /negocio.",
    );
  }
  const reglas = negocio.reglas.length
    ? negocio.reglas.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "Sin reglas especiales.";
  const pago =
    negocio.datosPago ||
    "No configurados. Si toca cobrar, deja [datos de pago] y avisa en alerts que falta configurar /pago.";
  return [
    `<negocio>\n${partes.join("\n")}\n</negocio>`,
    `<reglas>\n${reglas}\n</reglas>`,
    `<datos_pago>\n${pago}\n</datos_pago>`,
  ].join("\n\n");
}

const REVIEW_SYSTEM = `Eres Lucas, el agente de ventas de un negocio en Ecuador que vende por WhatsApp, y supervisas cómo atienden sus vendedores a los interesados.
Te pasan el final de una conversación real. Decide si el dueño del negocio necesita enterarse. Lo normal es que no: no marques detalles de estilo ni respuestas cortas pero correctas.

Marca teamAlert solo si hay algo real:
- mala_atencion: respuesta grosera, cortante o sarcástica; información falsa o contradictoria; promesas de resultados, descuentos o plazos que no se pueden cumplir; ignoró lo que el cliente preguntó; lo dejó esperando mucho tiempo sin explicación.
- cliente_molesto o cliente_en_riesgo: el cliente está enojado, amenaza con irse o cancelar.
- oportunidad: el cliente quiere comprar o está listo para pagar y nadie lo está aprovechando.
- cobro: reclama un cobro o dice que pagó y no se refleja.
level "urgente" solo si hay que actuar hoy. message: qué pasó y qué debería hacer el dueño, en 1 o 2 frases.`;

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
  negocio: ContextoNegocio;
  client: ClientDoc;
  totalConversations: number;
  current: ConversationWithMessages | null;
  previous: ConversationWithMessages[];
  instruction?: string;
}): Promise<{ data: Recommendation; usage: AiUsage }> {
  const sections: string[] = [
    formatNegocio(input.negocio),
    `<ficha_lead>\n${formatClient(input.client, input.totalConversations)}\n</ficha_lead>`,
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
      : "<conversacion_actual>Todavía no hay mensajes registrados con este lead.</conversacion_actual>",
  );
  sections.push(`Ahora es ${formatDate(new Date())} (hora de Ecuador).`);
  if (input.instruction) {
    sections.push(`<pedido_de_quien_vende>\n${input.instruction}\n</pedido_de_quien_vende>`);
  }
  sections.push("Qué le respondemos al lead para cerrar la venta?");

  const result = await generarObjeto({
    system: RECOMMENDATION_SYSTEM,
    content: [{ type: "text", text: sections.join("\n\n") }],
    schema: recommendationSchema,
    name: "recomendacion",
  });
  // Por si el modelo se salta la regla: sin signos de apertura ni markdown en lo que se copia.
  result.data.replies = result.data.replies.map((r) => ({ ...r, text: limpiarRespuesta(r.text) }));
  result.data.pago.mensaje = limpiarRespuesta(result.data.pago.mensaje);
  result.data.cierre.probabilidad = Math.max(
    0,
    Math.min(100, Math.round(result.data.cierre.probabilidad)),
  );
  return result;
}

function limpiarRespuesta(text: string): string {
  return text
    .replace(/[¡¿]/g, "")
    .replace(/\*\*?|__|^#+ /gm, "")
    .trim();
}
