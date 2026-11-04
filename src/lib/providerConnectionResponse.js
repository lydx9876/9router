import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function usesCodeartsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "codearts";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;

  // 华为云 AK/SK：SK 是写一次的密钥，读取时必须遮蔽
  if (usesCodeartsCredentialForm(connection.provider) && connection.providerSpecificData) {
    const { secretAccessKey, ...providerSpecificData } = connection.providerSpecificData;
    return { ...safe, providerSpecificData };
  }

  if (!usesAwsCredentialForm(connection.provider) || !connection.providerSpecificData) {
    return safe;
  }

  const { sessionToken, ...providerSpecificData } = connection.providerSpecificData;
  return { ...safe, providerSpecificData };
}
