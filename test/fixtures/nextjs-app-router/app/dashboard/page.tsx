import { ServerErrorFallback } from "@/components/error-fallback";

export default async function DashboardPage() {
  try {
    return null as unknown as JSX.Element;
  } catch (error) {
    return <ServerErrorFallback error={error as Error} />;
  }
}
