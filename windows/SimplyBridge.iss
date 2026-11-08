#define AppVersion "0.16.0"
#define StageDir "..\\build\\windows-stage"

[Setup]
AppId={{ECFD2263-E6CB-4E84-B94C-22F2EF5D408D}
AppName=SIMPLY BRIDGE
AppVersion={#AppVersion}
AppPublisher=SIMPLY
DefaultDirName={localappdata}\\Programs\\SimplyBridge
DefaultGroupName=SIMPLY BRIDGE
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=installer-output
OutputBaseFilename=SimplyBridge-Setup-v{#AppVersion}-win-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\\SimplyBridge.exe
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#StageDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\\SIMPLY BRIDGE"; Filename: "{app}\\SimplyBridge.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\\SIMPLY BRIDGE"; Filename: "{app}\\SimplyBridge.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\\SimplyBridge.exe"; Description: "Launch SIMPLY BRIDGE"; Flags: nowait postinstall skipifsilent
