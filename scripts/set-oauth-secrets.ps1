# Reads the Fission Gmail OAuth client from Windows Credential Manager and
# pushes it to GitHub Actions secrets. Values are never printed.
# NOTE: the keychain service is still "ZenBoxMail" (secrets migrate lazily) and
# the CI secret names stay ZENBOX_* to match .github/workflows/release.yml.
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredMan {
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr cred);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
        public int Persist; public int AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
    }
    public static string Read(string target) {
        IntPtr p;
        if (!CredRead(target, 1, 0, out p)) throw new Exception("CredRead failed for " + target);
        try {
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            var bytes = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);
            return System.Text.Encoding.UTF8.GetString(bytes);
        } finally { CredFree(p); }
    }
}
"@

$id = [CredMan]::Read("gmail:client_id.ZenBoxMail")
$secret = [CredMan]::Read("gmail:client_secret.ZenBoxMail")
if ($id.Length -lt 10 -or $secret.Length -lt 10) { throw "credential looks empty" }

$id | gh secret set ZENBOX_GMAIL_CLIENT_ID --repo swarnavspujari/email-productivity-client
if ($LASTEXITCODE -ne 0) { throw "gh secret set client id failed" }
$secret | gh secret set ZENBOX_GMAIL_CLIENT_SECRET --repo swarnavspujari/email-productivity-client
if ($LASTEXITCODE -ne 0) { throw "gh secret set client secret failed" }
Write-Output "OK: ZENBOX_GMAIL_CLIENT_ID ($($id.Length) chars) and ZENBOX_GMAIL_CLIENT_SECRET ($($secret.Length) chars) set"
