import { Suspense } from "react";
import { ReviewRoute, ReviewRouteFallback } from "@/components/ReviewRoute";

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<ReviewRouteFallback />}>
      <ReviewRoute params={params} />
    </Suspense>
  );
}
