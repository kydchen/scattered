import { normalizeBoard, parseImportedBoard } from "./model.js";

export const MAX_SHARE_BYTES = 256 * 1024;
export const SHARE_ID = /^[a-f0-9]{32}$/;
export const SHARE_TOKEN = /^[a-f0-9]{64}$/;

export function encodeSharedBoard(board, connectionStyle = "straight") {
  const value = normalizeBoard(board);
  // A presentation's camera belongs to the viewer, not the author.
  value.view = { x: 0, y: 0, scale: 1 };
  return JSON.stringify(parseSharedBoard(JSON.stringify({ board: value, connectionStyle })));
}

export function parseSharedBoard(encoded) {
  if (typeof encoded !== "string" || new TextEncoder().encode(encoded).length > MAX_SHARE_BYTES) {
    throw new Error("shareTooLarge");
  }
  const value = JSON.parse(encoded);
  if (!value || !["straight", "curved"].includes(value.connectionStyle)) throw new Error("shareInvalid");
  return {
    board: parseImportedBoard(JSON.stringify(value.board), { maxBytes: MAX_SHARE_BYTES }),
    connectionStyle: value.connectionStyle,
  };
}
