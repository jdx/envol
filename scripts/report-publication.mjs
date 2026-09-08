const {
  ENVOL_URL,
  ENVOL_CANDIDATE,
  ENVOL_DESTINATION,
  ENVOL_STATUS,
  ENVOL_EXTERNAL_ID,
  ENVOL_ERROR,
  ACTIONS_ID_TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN,
} = process.env;
if (
  !ENVOL_URL ||
  !ENVOL_CANDIDATE ||
  !ENVOL_DESTINATION ||
  !ENVOL_STATUS ||
  !ACTIONS_ID_TOKEN_REQUEST_URL ||
  !ACTIONS_ID_TOKEN_REQUEST_TOKEN
)
  throw new Error("Missing Actions/Envol environment");
const tokenURL = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
tokenURL.searchParams.set("audience", ENVOL_URL);
const tokenResponse = await fetch(tokenURL, {
  headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
});
if (!tokenResponse.ok) throw new Error("Could not obtain GitHub OIDC token");
const { value: token } = await tokenResponse.json();
const response = await fetch(
  `${ENVOL_URL.replace(/\/$/, "")}/api/publish/${encodeURIComponent(ENVOL_CANDIDATE)}/report/${encodeURIComponent(ENVOL_DESTINATION)}`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: ENVOL_STATUS === "success" ? "success" : "failure",
      external_id: ENVOL_EXTERNAL_ID || undefined,
      error:
        ENVOL_STATUS === "success" ? undefined : ENVOL_ERROR || "Job failed",
    }),
  },
);
if (!response.ok)
  throw new Error(
    `Publication report: ${response.status} ${await response.text()}`,
  );
