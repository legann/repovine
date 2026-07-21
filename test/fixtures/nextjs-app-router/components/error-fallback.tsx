import { Button } from "./ui/button";

export function ServerErrorFallback({ error }: { error: Error }) {
  return <Button>{error.message}</Button>;
}
