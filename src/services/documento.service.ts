import { CustomError } from "../errors/customError.error";
import { TgInlineKeyboard, TgMessage } from "../types/telegram";
import { leerDocumento } from "./ai.service";
import { agregarDocumento, getNegocio } from "./negocio.service";
import { OperatorDoc } from "./operator.service";
import { downloadFile, escapeHtml, sendMessage, sendTyping } from "./telegram.service";

/**
 * Flyers y PDFs del negocio como base de conocimiento de Lucas: la IA los lee
 * una vez, se guarda el texto (va en el contexto de cada respuesta) y el
 * file_id de Telegram para reenviarlos cuando se pidan.
 */

// Telegram no deja que un bot descargue archivos de más de 20 MB.
const MAX_BYTES = 20 * 1024 * 1024;

export interface Archivo {
  fileId: string;
  tipo: "pdf" | "imagen";
  nombre: string;
  bytes: number;
}

/** El flyer o PDF que trae el mensaje, si trae uno. */
export function archivoDeMensaje(message: TgMessage): Archivo | null {
  const photo = message.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, tipo: "imagen", nombre: "", bytes: photo.file_size ?? 0 };
  const doc = message.document;
  if (!doc) return null;
  const tipo = doc.mime_type === "application/pdf" ? "pdf" : doc.mime_type?.startsWith("image/") ? "imagen" : null;
  if (!tipo) return null;
  return { fileId: doc.file_id, tipo, nombre: doc.file_name ?? "", bytes: doc.file_size ?? 0 };
}

function mediaType(archivo: Archivo, path: string): string {
  if (archivo.tipo === "pdf") return "application/pdf";
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export async function guardarDocumento(operator: OperatorDoc, archivo: Archivo): Promise<void> {
  const chatId = operator.telegramChatId;
  if (!operator.negocio) throw new CustomError("Primero entra a un negocio.", 400);
  if (archivo.bytes > MAX_BYTES) {
    await sendMessage(chatId, "Ese archivo pesa más de 20 MB y Telegram no me deja abrirlo. Mándame una versión más liviana 🙏");
    return;
  }
  await sendMessage(chatId, "📚 Leyendo el documento…");
  await sendTyping(chatId);
  const file = await downloadFile(archivo.fileId);
  const { data } = await leerDocumento({ data: file.data, mediaType: mediaType(archivo, file.path) });
  if (!data.contenido) {
    await sendMessage(chatId, "No encontré información del negocio en ese archivo 🤔 Si es un flyer, mándamelo más nítido.");
    return;
  }
  const nombre = data.titulo || archivo.nombre || (archivo.tipo === "pdf" ? "Documento" : "Flyer");
  const total = await agregarDocumento(operator.negocio, {
    nombre,
    tipo: archivo.tipo,
    fileId: archivo.fileId,
    contenido: data.contenido,
    creadoEn: new Date(),
  });
  const vistazo = data.contenido.length > 500 ? `${data.contenido.slice(0, 500)}…` : data.contenido;
  await sendMessage(
    chatId,
    `✅ Guardé <b>${escapeHtml(nombre)}</b>. Ya lo uso al recomendarte respuestas y puedes preguntarme por él.\n\n<i>${escapeHtml(vistazo)}</i>\n\nTengo ${total} documento${total === 1 ? "" : "s"}: míralos con /documentos.`,
  );
}

export async function mostrarDocumentos(operator: OperatorDoc): Promise<void> {
  const negocio = await getNegocio(operator.negocio);
  const documentos = negocio?.documentos ?? [];
  if (!documentos.length) {
    await sendMessage(
      operator.telegramChatId,
      "Todavía no tengo documentos. Mándame un <b>PDF</b> o el <b>flyer</b> de tus programas y lo uso para responder a tus clientes.",
    );
    return;
  }
  const keyboard: TgInlineKeyboard = documentos.map((d, i) => [
    { text: `📎 ${i + 1}. ${d.nombre}`.slice(0, 60), callback_data: `vdoc:${i}` },
    ...(operator.role === "vendedor" ? [] : [{ text: "🗑️", callback_data: `qdoc:${i}` }]),
  ]);
  await sendMessage(
    operator.telegramChatId,
    `<b>Documentos que conozco</b>\nToca uno para que te lo mande y se lo reenvíes a tu cliente.\n\n${documentos
      .map((d, i) => `${i + 1}. ${d.tipo === "pdf" ? "📄" : "🖼️"} ${escapeHtml(d.nombre)}`)
      .join("\n")}`,
    keyboard,
  );
}
