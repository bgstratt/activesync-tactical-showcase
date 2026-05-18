import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { FeaturePage } from "./pages/FeaturePage";
import { DungeonBuilderPage } from "./pages/DungeonBuilderPage";
import { LandingPage } from "./pages/LandingPage";
import { ReplayInspectorPage } from "./pages/ReplayInspectorPage";
import { TacticalStrategyPage } from "./pages/TacticalStrategyPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/features/maps" element={<FeaturePage routePath="/features/maps" />} />
        <Route path="/features/entities" element={<FeaturePage routePath="/features/entities" />} />
        <Route path="/features/chat-presence" element={<FeaturePage routePath="/features/chat-presence" />} />
        <Route path="/features/assets" element={<FeaturePage routePath="/features/assets" />} />
        <Route path="/features/drawing" element={<FeaturePage routePath="/features/drawing" />} />
        <Route path="/features/inventory" element={<FeaturePage routePath="/features/inventory" />} />
        <Route path="/features/scripts" element={<FeaturePage routePath="/features/scripts" />} />
        <Route path="/features/offline" element={<FeaturePage routePath="/features/offline" />} />
        <Route path="/features/replay" element={<FeaturePage routePath="/features/replay" />} />
        <Route path="/modes/tactical-strategy" element={<TacticalStrategyPage />} />
        <Route path="/modes/dungeon-builder" element={<DungeonBuilderPage />} />
        <Route path="/modes/pixel-sandbox" element={<FeaturePage routePath="/modes/pixel-sandbox" />} />
        <Route path="/modes/card-battle" element={<FeaturePage routePath="/modes/card-battle" />} />
        <Route path="/modes/replay-inspector" element={<ReplayInspectorPage />} />
        <Route path="/diagnostics/topology" element={<FeaturePage routePath="/diagnostics/topology" />} />
        <Route path="/diagnostics/ops" element={<FeaturePage routePath="/diagnostics/ops" />} />
        <Route path="/diagnostics/assets" element={<FeaturePage routePath="/diagnostics/assets" />} />
        <Route path="/diagnostics/merges" element={<FeaturePage routePath="/diagnostics/merges" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
