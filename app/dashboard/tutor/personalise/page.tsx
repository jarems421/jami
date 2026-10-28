import TutorPersonaliseWorkspace from "@/components/ai/TutorPersonaliseWorkspace";
import AppPage from "@/components/layout/AppPage";
import { EmptyState } from "@/components/ui";
import { featureFlags } from "@/lib/app/feature-flags";

export default function TutorPersonalisePage() {
  if (!featureFlags.enableTutorPersonalisation) {
    return (
      <AppPage title="Your Jami" backHref="/dashboard/tutor" backLabel="Jami">
        <EmptyState
          title="Not enabled yet"
          description="Personalising Jami is behind a feature flag in this environment."
        />
      </AppPage>
    );
  }

  return <TutorPersonaliseWorkspace />;
}
