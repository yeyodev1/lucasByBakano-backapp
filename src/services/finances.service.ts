import axios from "axios";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

/**
 * Cobros de Bakano. Viven en finances-bakano-backapp: facturas por cliente
 * (enlazado al workspace de Metrics) y links de pago de Stripe. Lucas usa el
 * mismo API servidor a servidor que usa Metrics para su portal
 * (/portal/workspaces/:id/..., header x-metrics-key).
 */

const OPEN_STATUSES = ["pending", "partial", "overdue"];

export interface FacturaAbierta {
  id: string;
  periodo: string;
  etiqueta: string;
  saldo: number;
  moneda: string;
  estado: "pending" | "partial" | "overdue";
  vence: Date | null;
}

export interface CobroEntorno {
  workspaceId: string;
  cliente: string;
  saldoPendiente: number;
  facturas: FacturaAbierta[];
  vencidas: number;
  stripeActivo: boolean;
}

export function financesConfigurado(): boolean {
  return Boolean(env.FINANCES_API_URL && env.FINANCES_PORTAL_KEY);
}

function api() {
  return axios.create({
    baseURL: env.FINANCES_API_URL.replace(/\/$/, ""),
    headers: { "x-metrics-key": env.FINANCES_PORTAL_KEY },
    timeout: 15000,
  });
}

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** "2026-09" → "septiembre 2026" */
export function periodoLegible(periodo: string): string {
  const [anio, mes] = periodo.split("-").map(Number);
  return MESES[mes - 1] ? `${MESES[mes - 1]} ${anio}` : periodo;
}

/** Saldo del entorno. null si no tiene facturación vinculada en finances. */
export async function cobroDeEntorno(workspaceId: string): Promise<CobroEntorno | null> {
  if (!financesConfigurado()) return null;
  try {
    const { data } = await api().get(`/portal/workspaces/${workspaceId}/billing`);
    const facturas: FacturaAbierta[] = (data.invoices ?? [])
      .filter((inv: any) => OPEN_STATUSES.includes(inv.status))
      .map((inv: any) => ({
        id: String(inv._id ?? inv.id),
        periodo: inv.period,
        etiqueta: inv.splitLabel ?? "",
        saldo: Number(Math.max(inv.amount - (inv.paidAmount || 0), 0).toFixed(2)),
        moneda: inv.currency ?? "USD",
        estado: inv.status,
        vence: inv.dueDate ? new Date(inv.dueDate) : null,
      }))
      .filter((f: FacturaAbierta) => f.saldo > 0)
      // La más antigua primero: es la que se cobra primero.
      .sort((a: FacturaAbierta, b: FacturaAbierta) => a.periodo.localeCompare(b.periodo));

    return {
      workspaceId,
      cliente: data.client?.name ?? "",
      saldoPendiente: Number(data.summary?.pendingBalance ?? 0),
      facturas,
      vencidas: facturas.filter((f) => f.estado === "overdue").length,
      stripeActivo: Boolean(data.summary?.stripeEnabled),
    };
  } catch (error: any) {
    if (error?.response?.status === 404) return null;
    console.error("[finances] saldo de", workspaceId, error?.message ?? error);
    return null;
  }
}

/** Link de Stripe para pagar una factura abierta. Cobra solo el saldo que falta. */
export async function linkDePago(workspaceId: string, invoiceId: string): Promise<string> {
  if (!financesConfigurado()) {
    throw new CustomError("Falta conectar finanzas (FINANCES_API_URL y FINANCES_PORTAL_KEY)", 503);
  }
  try {
    const { data } = await api().post(`/portal/workspaces/${workspaceId}/checkout-session`, {
      invoiceId,
      returnUrl: env.PAGO_RETURN_URL,
    });
    if (!data?.url) throw new Error("sin url");
    return data.url as string;
  } catch (error: any) {
    const message = error?.response?.data?.message;
    if (error?.response?.status === 409) {
      throw new CustomError(message ?? "Esa factura ya no tiene saldo pendiente", 409);
    }
    console.error("[finances] link de pago:", error?.message ?? error);
    throw new CustomError(message ?? "No pude generar el link de pago", 502);
  }
}

/** Corre tareas de a pocas: finances no debe recibir decenas de consultas de golpe. */
export async function enLotes<T, R>(
  items: T[],
  tam: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += tam) {
    out.push(...(await Promise.all(items.slice(i, i + tam).map(fn))));
  }
  return out;
}
