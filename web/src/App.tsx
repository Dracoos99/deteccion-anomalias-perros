import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAccount, RequireAdmin } from "./auth/guards";
import { Shell } from "./components/Shell";
import { EmptyState } from "./components/ui";
import { AlertDetail } from "./pages/AlertDetail";
import { AlertsPage } from "./pages/AlertsPage";
import { AuthPage } from "./pages/AuthPage";
import { CompleteProfile } from "./pages/CompleteProfile";
import { CsvUploadPage } from "./pages/CsvUploadPage";
import { DogDetail } from "./pages/DogDetail";
import { DogForm } from "./pages/DogForm";
import { Home } from "./pages/Home";
import { ProfilePage } from "./pages/ProfilePage";
import { VetView } from "./pages/VetView";

// Research tools load as a separate chunk, only when an admin opens /admin.
const SimulatorPage = lazy(() => import("./pages/SimulatorPage").then((m) => ({ default: m.SimulatorPage })));
const ConfigPage = lazy(() => import("./pages/ConfigPage").then((m) => ({ default: m.ConfigPage })));
const adminPage = (page: ReactNode) => <RequireAdmin><Suspense fallback={<div className="boot">Cargando…</div>}>{page}</Suspense></RequireAdmin>;

function NotFound() {
  return (
    <main className="page" id="main">
      <EmptyState icon="info" title="No encontramos esta página" text="Revisa la dirección o vuelve al inicio."
        action={<Link className="btn btn-secondary" to="/">Ir al inicio</Link>} />
    </main>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <a className="skip-link" href="#main">Saltar al contenido</a>
        <Routes>
          <Route path="/acceso" element={<AuthPage mode="login" />} />
          <Route path="/acceso/registro" element={<AuthPage mode="registro" />} />
          <Route path="/acceso/recuperar" element={<AuthPage mode="recuperar" />} />
          <Route path="/acceso/completar" element={<CompleteProfile />} />
          <Route element={<RequireAccount><Shell /></RequireAccount>}>
            <Route path="/" element={<Home />} />
            <Route path="/alertas" element={<AlertsPage />} />
            <Route path="/alertas/:alertId" element={<AlertDetail />} />
            <Route path="/perros/nuevo" element={<DogForm />} />
            <Route path="/perros/:dogId" element={<DogDetail />} />
            <Route path="/perros/:dogId/editar" element={<DogForm />} />
            <Route path="/perros/:dogId/veterinario" element={<VetView />} />
            <Route path="/perfil" element={<ProfilePage />} />
            <Route path="/perfil/datos" element={<CsvUploadPage />} />
            <Route path="/admin" element={adminPage(<SimulatorPage />)} />
            <Route path="/admin/configuracion" element={adminPage(<ConfigPage />)} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
