export function GET() {
  return new Response('<!doctype html><html><body><h1>Synthetic navigation failure</h1></body></html>', {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
