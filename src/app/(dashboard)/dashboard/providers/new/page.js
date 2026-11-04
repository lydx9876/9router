"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Button, Input, Select, Toggle } from "@/shared/components";
import { AI_PROVIDERS, AUTH_METHODS } from "@/shared/constants/config";

const providerOptions = Object.values(AI_PROVIDERS).map((p) => ({
  value: p.id,
  label: p.name,
}));

const authMethodOptions = Object.values(AUTH_METHODS).map((m) => ({
  value: m.id,
  label: m.name,
}));

export default function NewProviderPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    provider: "",
    authMethod: "api_key",
    apiKey: "",
    displayName: "",
    isActive: true,
  });
  const [codeartsData, setCodeartsData] = useState({ accessKeyId: "", secretAccessKey: "" });
  const [errors, setErrors] = useState({});

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.provider) newErrors.provider = "Please select a provider";
    if (formData.authMethod === "api_key" && usesCodeartsCredentialForm) {
      if (!codeartsData.accessKeyId.trim()) newErrors.codeartsAk = "Access Key ID is required";
      if (!codeartsData.secretAccessKey.trim()) newErrors.codeartsSk = "Secret Access Key is required";
    } else if (formData.authMethod === "api_key" && !formData.apiKey) {
      newErrors.apiKey = "API Key is required";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          ...(usesCodeartsCredentialForm
            ? {
                providerSpecificData: {
                  accessKeyId: codeartsData.accessKeyId.trim(),
                  secretAccessKey: codeartsData.secretAccessKey.trim(),
                },
              }
            : {}),
        }),
      });

      if (response.ok) {
        router.push("/dashboard/providers");
      } else {
        const data = await response.json();
        setErrors({ submit: data.error || "Failed to create provider" });
      }
    } catch (error) {
      setErrors({ submit: "An error occurred. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const selectedProvider = AI_PROVIDERS[formData.provider];
  const usesCodeartsCredentialForm = selectedProvider?.credentialForm === "codearts";

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <Link
          href="/dashboard/providers"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Back to Providers
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Add New Provider</h1>
        <p className="text-text-muted mt-2">
          Configure a new AI provider to use with your applications.
        </p>
      </div>

      {/* Form */}
      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Provider Selection */}
          <Select
            label="Provider"
            options={providerOptions}
            value={formData.provider}
            onChange={(e) => handleChange("provider", e.target.value)}
            placeholder="Select a provider"
            error={errors.provider}
            required
          />

          {/* Provider Info */}
          {selectedProvider && (
            <Card.Section className="flex items-center gap-3">
              <div
                className="size-10 rounded-lg flex items-center justify-center bg-bg border border-border"
              >
                <span
                  className="material-symbols-outlined text-xl"
                  style={{ color: selectedProvider.color }}
                >
                  {selectedProvider.icon}
                </span>
              </div>
              <div>
                <p className="font-medium">{selectedProvider.name}</p>
                <p className="text-sm text-text-muted">
                  Selected provider
                </p>
              </div>
            </Card.Section>
          )}

          {/* Auth Method */}
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium">
              Authentication Method <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-3">
              {authMethodOptions.map((method) => (
                <button
                  key={method.value}
                  type="button"
                  onClick={() => handleChange("authMethod", method.value)}
                  className={`flex-1 flex items-center justify-center gap-2 p-4 rounded-lg border transition-all ${
                    formData.authMethod === method.value
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <span className="material-symbols-outlined">
                    {method.value === "api_key" ? "key" : "lock"}
                  </span>
                  <span className="font-medium">{method.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* API Key Input */}
          {formData.authMethod === "api_key" && !usesCodeartsCredentialForm && (
            <Input
              label="API Key"
              type="password"
              placeholder="Enter your API key"
              value={formData.apiKey}
              onChange={(e) => handleChange("apiKey", e.target.value)}
              error={errors.apiKey}
              hint="Your API key will be encrypted and stored securely."
              required
            />
          )}

          {/* 华为云 IAM 凭据（码道用 AK/SK 签名，不用 Bearer API Key） */}
          {formData.authMethod === "api_key" && usesCodeartsCredentialForm && (
            <div className="flex flex-col gap-3">
              <div className="p-3 rounded-md border border-amber-500/40 bg-amber-500/10 text-xs leading-relaxed">
                <p className="font-medium text-amber-600 dark:text-amber-400 mb-1">
                  ⚠️ 聊天接口暂不可用
                </p>
                <p>
                  码道现在要求请求体经 SM4-GCM 加密（先做一次 key-exchange 换取会话密钥）。
                  签名部分已实现并与官方 CLI 逐字节一致，但加密层尚未完成，因此
                  chat 请求会返回 401 <code>verify ak sk signature fail</code>（该提示有误导性，
                  签名本身是对的）。
                </p>
                <p className="mt-1">
                  <strong>配额跟踪不受影响</strong>，可在 Usage 面板确认凭据是否有效。
                </p>
              </div>
              <Input
                label="Access Key ID"
                placeholder="HPUA••••••••••••••••"
                value={codeartsData.accessKeyId}
                onChange={(e) => setCodeartsData({ ...codeartsData, accessKeyId: e.target.value })}
                error={errors.codeartsAk}
                hint="在 https://codearts.huaweicloud.com/portal/settings/cli-auth 申请"
                required
              />
              <Input
                label="Secret Access Key"
                type="password"
                placeholder="Enter your secret key"
                value={codeartsData.secretAccessKey}
                onChange={(e) => setCodeartsData({ ...codeartsData, secretAccessKey: e.target.value })}
                error={errors.codeartsSk}
                hint="将加密存储。请求时用 IAM SDK-HMAC-SHA256 签名。"
                required
              />
            </div>
          )}

          {/* OAuth2 Button */}
          {formData.authMethod === "oauth2" && (
            <Card.Section>
              <p className="text-sm text-text-muted mb-4">
                Connect your account using OAuth2 authentication.
              </p>
              <Button type="button" variant="secondary" icon="link">
                Connect with OAuth2
              </Button>
            </Card.Section>
          )}

          {/* Display Name */}
          <Input
            label="Display Name"
            placeholder="e.g., Production API, Dev Environment"
            value={formData.displayName}
            onChange={(e) => handleChange("displayName", e.target.value)}
            hint="Optional. A friendly name to identify this configuration."
          />

          {/* Active Toggle */}
          <Toggle
            checked={formData.isActive}
            onChange={(checked) => handleChange("isActive", checked)}
            label="Active"
            description="Enable this provider for use in your applications"
          />

          {/* Error Message */}
          {errors.submit && (
            <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
              {errors.submit}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t border-border">
            <Link href="/dashboard/providers" className="flex-1">
              <Button type="button" variant="ghost" fullWidth>
                Cancel
              </Button>
            </Link>
            <Button type="submit" loading={loading} fullWidth className="flex-1">
              Create Provider
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

