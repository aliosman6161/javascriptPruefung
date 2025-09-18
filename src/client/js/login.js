const API_BASE = "http://localhost:3001";

const form = document.getElementById("login-form");
const errBox = document.getElementById("login-error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errBox.textContent = "";

  const username = new FormData(form).get("username")?.toString().trim() || "";
  const password = new FormData(form).get("password")?.toString() || "";

  if (!username || !password) {
    errBox.textContent = "Bitte Benutzer und Passwort eingeben.";
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.message || `Login fehlgeschlagen (HTTP ${res.status})`);
    }

    const data = await res.json().catch(() => ({}));
    if (!data?.ok || !data?.username) throw new Error("Unerwartete Antwort vom Server.");

    // "Logged-in" Zustand für die App
    localStorage.setItem("ip_user", data.username);

    // Weiter zur App
    location.href = "./index.html";
  } catch (err) {
    errBox.textContent = String(err.message || err);
  }
});
