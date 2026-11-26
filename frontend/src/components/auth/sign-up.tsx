"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { signUp } from "../../lib/auth-client";
import { attributionMetadata, getAnonymousAttribution } from "@/lib/attribution";
import { postAuthPath } from "@/lib/auth-redirect";
import { track } from "@/lib/datafast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Better Auth answers in English; show the common cases in Portuguese. */
const SIGN_UP_ERRORS: Record<string, string> = {
  USER_ALREADY_EXISTS: "Já existe uma conta com este e-mail. Entre ou redefina a senha.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Já existe uma conta com este e-mail. Entre ou redefina a senha.",
  PASSWORD_TOO_SHORT: "A senha precisa ter pelo menos 8 caracteres.",
  PASSWORD_TOO_LONG: "A senha é longa demais.",
  INVALID_EMAIL: "Esse e-mail não parece válido.",
  EMAIL_AND_PASSWORD_SIGN_UP_IS_NOT_ENABLED: "Cadastros estão fechados no momento.",
};

export function SignUp() {
  const t = useTranslations("auth");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");
    setOk(false);

    let response: Awaited<ReturnType<typeof signUp.email>>;
    try {
      response = await signUp.email({
        email: email.trim(),
        password,
        name: name.trim(),
      });
    } catch {
      // Network failure or server down: never leave the button spinning.
      setMessage("Não foi possível criar a conta agora. Verifique sua conexão e tente de novo.");
      setLoading(false);
      return;
    }

    if (response.error) {
      const code = (response.error as { code?: string }).code ?? "";
      setMessage(SIGN_UP_ERRORS[code] || response.error.message || t("signUp.failed"));
      setLoading(false);
      return;
    }

    track("signup_completed", {
      auth_method: "email",
      ...attributionMetadata(getAnonymousAttribution()),
    });
    setOk(true);
    setMessage(t("signUp.success"));
    setLoading(false);

    // Automatically sign in after successful sign up
    setTimeout(() => {
      window.location.href = postAuthPath(window.location.search);
    }, 1000);
  };

  return (
    <div className="w-full">
      <h1 className="font-display text-3xl font-bold tracking-tight">{t("signUp.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("signUp.subtitle")}</p>
      <div className="mt-8">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            className="h-11"
            type="text"
            autoComplete="name"
            placeholder={t("signUp.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={loading}
          />
          <Input
            className="h-11"
            type="email"
            autoComplete="email"
            placeholder={t("signUp.email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
          />
          <Input
            className="h-11"
            type="password"
            autoComplete="new-password"
            placeholder={t("signUp.password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            minLength={8}
          />
          <Button type="submit" className="h-11 w-full" disabled={loading}>
            {loading ? t("signUp.submitting") : t("signUp.submit")}
          </Button>
        </form>
        {message && (
          <p className={`mt-4 text-sm ${ok ? "text-green-600" : "text-red-600"}`}>
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
