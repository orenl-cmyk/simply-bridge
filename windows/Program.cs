using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace SimplyBridge;

internal static class Program
{
    private const string Version = "0.16.0";
    private static readonly string StateDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SimplyBridge");
    private static readonly string EndpointFile = Path.Combine(StateDirectory, "endpoint.json");
    private static readonly string LogFile = Path.Combine(StateDirectory, "simply-bridge.log");
    private static Process? server;
    private static NotifyIcon? trayIcon;
    private static string? localUrl;
    private static StreamWriter? logWriter;

    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Directory.CreateDirectory(StateDirectory);

        using var mutex = new Mutex(true, $"Local\\SimplyBridge-{Version}", out var ownsMutex);
        if (!ownsMutex)
        {
            OpenSavedEndpoint();
            return;
        }

        try
        {
            StartBridge();
            Application.Run();
        }
        catch (Exception exception)
        {
            WriteLog(exception.ToString());
            MessageBox.Show(
                $"SIMPLY BRIDGE לא הצליח להיפתח.\n\n{exception.Message}\n\nיומן: {LogFile}",
                "SIMPLY BRIDGE",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error,
                MessageBoxDefaultButton.Button1,
                MessageBoxOptions.RightAlign | MessageBoxOptions.RtlReading);
        }
        finally
        {
            StopBridge();
        }
    }

    private static void StartBridge()
    {
        var installDirectory = AppContext.BaseDirectory;
        var nodePath = Path.Combine(installDirectory, "runtime", "node.exe");
        var serverPath = Path.Combine(installDirectory, "app", "server.mjs");
        var appDirectory = Path.Combine(installDirectory, "app");
        var dataDirectory = Path.Combine(StateDirectory, "data");

        if (!File.Exists(nodePath) || !File.Exists(serverPath))
            throw new FileNotFoundException("חסרים קובצי ההרצה. חלצו את כל קובץ ה-ZIP לתיקייה אחת או התקינו מחדש.");

        Directory.CreateDirectory(dataDirectory);
        var port = FindAvailablePort(4318, 4399);
        localUrl = $"http://127.0.0.1:{port}/";
        File.WriteAllText(EndpointFile, JsonSerializer.Serialize(new { url = localUrl, processId = Environment.ProcessId }));

        logWriter = new StreamWriter(new FileStream(LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };
        WriteLog($"Starting SIMPLY BRIDGE {Version} at {localUrl}");

        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = appDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add(serverPath);
        startInfo.Environment["HOST"] = "127.0.0.1";
        startInfo.Environment["PORT"] = port.ToString();
        startInfo.Environment["PUBLIC_URL"] = localUrl;
        startInfo.Environment["DATA_DIR"] = dataDirectory;

        server = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        server.OutputDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) WriteLog(eventArgs.Data); };
        server.ErrorDataReceived += (_, eventArgs) => { if (eventArgs.Data is not null) WriteLog("ERROR " + eventArgs.Data); };
        server.Exited += (_, _) =>
        {
            WriteLog($"Server stopped with exit code {server?.ExitCode}");
            if (Application.MessageLoop) Application.Exit();
        };

        if (!server.Start()) throw new InvalidOperationException("לא ניתן להפעיל את שרת SIMPLY BRIDGE.");
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();

        WaitUntilReady(localUrl, TimeSpan.FromSeconds(30));
        CreateTrayIcon(dataDirectory);
        OpenBrowser(localUrl);
    }

    private static void CreateTrayIcon(string dataDirectory)
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("פתיחת SIMPLY BRIDGE", null, (_, _) => OpenBrowser(localUrl));
        menu.Items.Add("פתיחת תיקיית הנתונים", null, (_, _) => Process.Start(new ProcessStartInfo("explorer.exe", dataDirectory) { UseShellExecute = true }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("יציאה", null, (_, _) => Application.Exit());

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "SIMPLY BRIDGE",
            ContextMenuStrip = menu,
            Visible = true
        };
        trayIcon.DoubleClick += (_, _) => OpenBrowser(localUrl);
    }

    private static int FindAvailablePort(int first, int last)
    {
        for (var port = first; port <= last; port++)
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                listener.Stop();
                return port;
            }
            catch (SocketException) { }
        }
        throw new InvalidOperationException($"לא נמצא פורט פנוי בין {first} ל-{last}.");
    }

    private static void WaitUntilReady(string url, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (server?.HasExited == true)
                throw new InvalidOperationException($"השרת נסגר בזמן ההפעלה. בדקו את היומן: {LogFile}");
            try
            {
                using var response = client.GetAsync(url).GetAwaiter().GetResult();
                if (response.IsSuccessStatusCode) return;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            Thread.Sleep(250);
        }
        throw new TimeoutException($"השרת לא היה מוכן בתוך 30 שניות. בדקו את היומן: {LogFile}");
    }

    private static void OpenSavedEndpoint()
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(EndpointFile));
            OpenBrowser(document.RootElement.GetProperty("url").GetString());
        }
        catch
        {
            MessageBox.Show("SIMPLY BRIDGE כבר פועל. פתחו אותו מהסמל ליד השעון.", "SIMPLY BRIDGE");
        }
    }

    private static void OpenBrowser(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private static void StopBridge()
    {
        if (trayIcon is not null) trayIcon.Visible = false;
        try
        {
            if (server is { HasExited: false })
            {
                server.Kill(true);
                server.WaitForExit(5000);
            }
        }
        catch { }
        try { File.Delete(EndpointFile); } catch { }
        WriteLog("SIMPLY BRIDGE stopped");
        logWriter?.Dispose();
    }

    private static void WriteLog(string message)
    {
        try { logWriter?.WriteLine($"[{DateTimeOffset.Now:O}] {message}"); } catch { }
    }
}
