import { Setting } from "../models/setting.model";

export const BUSINESS_KEY = "business";

export async function getSetting(key: string): Promise<string> {
  const setting = await Setting.findOne({ key }).lean<{ value: string }>();
  return setting?.value ?? "";
}

export async function setSetting(key: string, value: string, updatedBy: string): Promise<string> {
  await Setting.updateOne({ key }, { $set: { value: value.trim(), updatedBy } }, { upsert: true });
  return value.trim();
}
