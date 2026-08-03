export const handler = async (event) => ({ statusCode: 200, body: String(event.Records?.length ?? 0) });
