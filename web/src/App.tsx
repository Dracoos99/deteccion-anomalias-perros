import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAccount, RequireAdmin } from "./auth/guards";
import { Shell } from "./components/Shell";
import { EmptyState, PageLoading } from "./components/ui";
import { AuthPage } from "./pages/AuthPage";
import { Home } from "./pages/Home";

// The first screens (sign-in and Inicio) come with the app; every other page loads when it is first opened, so a phone
// downloads much less before it shows anything. The research tools also load apart, only for an admin.
const AlertDetail = lazy(() => import("./pages/AlertDetail").then((m) => ({ default: m.AlertDetail })));
const AlertsPage = lazy(() => import("./pages/AlertsPage").then((m) => ({ default: m.AlertsPage })));
const CompleteProfile = lazy(() => import("./pages/CompleteProfile").then((m) => ({ default: m.CompleteProfile })));
const CsvUploadPage = lazy(() => import("./pages/CsvUploadPage").then((m) => ({ default: m.CsvUploadPage })));
const DogDetail = lazy(() => import("./pages/DogDetail").then((m) => ({ default: m.DogDetail })));
const DogForm = lazy(() => import("./pages/DogForm").then((m) => ({ default: m.DogForm })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const VetView = lazy(() => import("./pages/VetView").then((m) => ({ default: m.VetView })));
const SimulatorPage = lazy(() => import("./pages/SimulatorPage").then((m) => ({ default: m.SimulatorPage })));
const ConfigPage = lazy(() => import("./pages/ConfigPage").then((m) => ({ default: m.ConfigPage })));
const page = (el: ReactNode, shape?: "detail" | "sheet") => <Suspense fallback={<PageLoading shape={shape} />}>{el}</Suspense>;
const adminPage = (el: ReactNode) => <RequireAdmin>{page(el)}</RequireAdmin>;

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
          <Route path="/acceso/completar" element={page(<CompleteProfile />)} />
          <Route element={<RequireAccount><Shell /></RequireAccount>}>
            <Route path="/" element={<Home />} />
            <Route path="/alertas" element={page(<AlertsPage />)} />
            <Route path="/alertas/:alertId" element={page(<AlertDetail />)} />
            <Route path="/perros/nuevo" element={page(<DogForm />)} />
            <Route path="/perros/:dogId" element={page(<DogDetail />, "detail")} />
            <Route path="/perros/:dogId/editar" element={page(<DogForm />)} />
            <Route path="/perros/:dogId/veterinario" element={page(<VetView />, "sheet")} />
            <Route path="/perfil" element={page(<ProfilePage />)} />
            <Route path="/perfil/datos" element={page(<CsvUploadPage />)} />
            <Route path="/admin" element={adminPage(<SimulatorPage />)} />
            <Route path="/admin/configuracion" element={adminPage(<ConfigPage />)} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
