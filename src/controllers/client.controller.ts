import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { CustomError } from "../errors/customError.error";
import * as clientService from "../services/client.service";
import * as conversationService from "../services/conversation.service";

/** GET /api/clients?q=&stage=&page= */
export async function listClients(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { q, stage, page } = req.query;
    const result = await clientService.listClients({
      q: q !== undefined ? String(q) : undefined,
      stage: stage !== undefined ? String(stage) : undefined,
      page: page !== undefined ? Number(page) : undefined,
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** GET /api/clients/search?q= */
export async function searchClients(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { q } = req.query;
    const items = await clientService.searchClients(String(q ?? ""));
    res.status(200).json({ items });
  } catch (error) {
    next(error);
  }
}

/** POST /api/clients — body: { name, phones?, email?, company?, telegramUsername?, stage?, source?, interests?, tags? } */
export async function createClient(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { name, phones, email, company, telegramUsername, stage, source, interests, tags } =
      req.body ?? {};
    const client = await clientService.createClient({
      name: String(name ?? ""),
      phones,
      email,
      company,
      telegramUsername,
      stage,
      source,
      interests,
      tags,
    });
    res.status(201).json(client);
  } catch (error) {
    next(error);
  }
}

/** GET /api/clients/:id — devuelve la ficha y su primera página de conversaciones. */
export async function getClient(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const client = await clientService.getClientById(id);
    const conversations = await conversationService.listConversations(id, 1);
    res.status(200).json({ client, conversations });
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/clients/:id */
export async function updateClient(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const { name, phones, email, company, telegramUsername, stage, source, interests, tags, summary } =
      req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (phones !== undefined) patch.phones = phones;
    if (email !== undefined) patch.email = email;
    if (company !== undefined) patch.company = company;
    if (telegramUsername !== undefined) patch.telegramUsername = telegramUsername;
    if (stage !== undefined) patch.stage = stage;
    if (source !== undefined) patch.source = source;
    if (interests !== undefined) patch.interests = interests;
    if (tags !== undefined) patch.tags = tags;
    if (summary !== undefined) patch.summary = summary;

    const client = await clientService.updateClient(id, patch);
    res.status(200).json(client);
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/clients/:id */
export async function deleteClient(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    await clientService.deleteClient(id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

/** POST /api/clients/:id/notes — body: { text } */
export async function addNote(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const { text } = req.body ?? {};
    const author = req.user?.email ?? "admin";
    const client = await clientService.addNote(id, String(text ?? ""), author);
    res.status(200).json(client);
  } catch (error) {
    next(error);
  }
}

/** GET /api/clients/:id/conversations?page= */
export async function listClientConversations(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const { page } = req.query;
    const result = await conversationService.listConversations(id, page !== undefined ? Number(page) : 1);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
