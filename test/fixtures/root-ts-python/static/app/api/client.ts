export async function fetchHealth(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/api/health/`);
}
