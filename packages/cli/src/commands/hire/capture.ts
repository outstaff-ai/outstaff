import type { Context } from "#/types.js";

export const capture = (ctx: Context): { ctx: Context; text: () => string } => {
  let out = "";
  let err = "";
  return {
    ctx: { ...ctx, out: (t) => void (out += t), err: (t) => void (err += t) },
    text: () => out + err,
  };
};

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
