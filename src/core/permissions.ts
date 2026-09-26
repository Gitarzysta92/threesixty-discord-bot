import { PermissionFlagsBits } from 'discord.js';
import type { PermissionsBitField } from 'discord.js';

export function canExecute(required: string | null | undefined, actual: Readonly<PermissionsBitField> | null): boolean {
  if (required == null) return true;
  return actual?.has(required === '0' ? PermissionFlagsBits.Administrator : BigInt(required)) ?? false;
}
