import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HomePage } from "../features/home/HomePage";
import { EloraConsolePage } from "../features/elora-console/EloraConsolePage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/elora" element={<EloraConsolePage />} />
      </Routes>
    </BrowserRouter>
  );
}
