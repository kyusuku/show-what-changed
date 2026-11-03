export function GET() {
  return Response.json({ ready: true }, { headers: { 'cache-control': 'no-store' } });
}
