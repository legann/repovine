export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export const VERSION = '1.0.0';
