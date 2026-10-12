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
const DogsPage = lazy(() => import("./pages/DogsPage").then((m) => ({ default: m.DogsPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const VetView = lazy(() => import("./pages/VetView").then((m) => ({ default: m.VetView })));
const AdminConsole = lazy(() => import("./pages/AdminConsole").then((m) => ({ default: m.AdminConsole })));
const SimulatorPage = lazy(() => import("./pages/SimulatorPage").then((m) => ({ default: m.SimulatorPage })));
const ConfigPage = lazy(() => import("./pages/ConfigPage").then((m) => ({ default: m.ConfigPage })));
const ReviewPage = lazy(() => import("./pages/ReviewPage").then((m) => ({ default: m.ReviewPage })));
const page = (el: ReactNode, shape?: "detail" | "sheet") => <Suspense fallback={<PageLoading shape={shape} />}>{el}</Suspense>;

function NotFound() {
  return (
    <main className="page" id="main">
      <EmptyState icon="info" title="No encontramos esta página" text="Revisa la dirección o vuelve al inicio."
        action={<Link className="btn btn-secondary" to="/">Ir al inicio</Link>} />
    </main>
  );
}

/* Routes by role: the owner's sections (Inicio, Perros, Alertas, and the account pages of the avatar menu)
   are open to any account; the Consola Admin is one guarded layout whose pages load only for an admin account. */
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
            <Route path="/perros" element={page(<DogsPage />)} />
            <Route path="/perros/nuevo" element={page(<DogForm />)} />
            <Route path="/perros/:dogId" element={page(<DogDetail />, "detail")} />
            <Route path="/perros/:dogId/editar" element={page(<DogForm />)} />
            <Route path="/perros/:dogId/veterinario" element={page(<VetView />, "sheet")} />
            <Route path="/perfil/datos" element={page(<CsvUploadPage />)} />
            <Route path="/alertas" element={page(<AlertsPage />)} />
            <Route path="/alertas/:alertId" element={page(<AlertDetail />)} />
            <Route path="/perfil" element={page(<ProfilePage />)} />
            <Route path="/configuracion" element={page(<SettingsPage />)} />
            <Route path="/admin" element={<RequireAdmin>{page(<AdminConsole />)}</RequireAdmin>}>
              <Route index element={<SimulatorPage />} />
              <Route path="configuracion" element={<ConfigPage />} />
              <Route path="ingesta" element={<CsvUploadPage />} />
              <Route path="revision" element={<ReviewPage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
