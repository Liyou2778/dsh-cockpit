using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DSHCockpit;

internal static class Program
{
    public const int Port = 7777;
    public const int GatewayPort = 7891;

    internal static readonly string LogPath = Path.Combine(AppContext.BaseDirectory, "app.log");
    internal static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DSHCockpit");

    internal static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"[{DateTime.Now:HH:mm:ss.fff}] {message}\r\n");
        }
        catch { /* 日志失败不影响主流程 */ }
    }

    [STAThread]
    private static void Main()
    {
        Log("=== app start (whale edition) ===");
        try { Directory.CreateDirectory(DataDir); } catch { }
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log($"UNHANDLED: {e.ExceptionObject}");
        Application.ThreadException += (_, e) => Log($"THREAD EXCEPTION: {e.Exception}");
        try
        {
            using var mutex = new Mutex(true, "DSHCockpit.SingleInstance.v1", out var isNew);
            if (!isNew) { Log("already running"); return; }
            ApplicationConfiguration.Initialize();
            Application.Run(new MainForm());
            Log("=== app exit ===");
        }
        catch (Exception ex)
        {
            Log($"FATAL: {ex}");
            MessageBox.Show($"启动失败：{ex.Message}\n日志：{LogPath}", "DSH 驾驶舱", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    public static Icon AppIcon()
    {
        try
        {
            using var stream = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "assets", "app.ico"));
            return new Icon(stream);
        }
        catch
        {
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application; }
            catch { return SystemIcons.Application; }
        }
    }
}

internal sealed class MainForm : Form
{
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly Label _status = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font("Microsoft YaHei UI", 12f),
        ForeColor = Color.FromArgb(27, 35, 66),
        BackColor = Color.FromArgb(241, 244, 253),
        Text = "正在启动驾驶舱服务…",
    };
    private readonly NotifyIcon _tray;
    private readonly string _root;
    private readonly string _widgetPosFile = Path.Combine(Program.DataDir, "widget.json");
    private Process? _server;
    private bool _ownsServer;
    private WidgetForm? _widget;
    private bool _exiting;

    private static void Log(string message) => Program.Log(message);

    public MainForm()
    {
        Text = "DSH 驾驶舱";
        Width = 1500;
        Height = 1000;
        MinimumSize = new Size(1080, 720);
        StartPosition = FormStartPosition.CenterScreen;
        _root = FindProjectRoot();
        Log($"root={_root}");
        Icon = Program.AppIcon();
        Controls.Add(_status);
        Controls.Add(_web);

        _tray = new NotifyIcon
        {
            Icon = Program.AppIcon(),
            Text = "DSH 驾驶舱 · 小鲸鱼",
            Visible = true,
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开驾驶舱", null, (_, _) => RestoreFromWidget());
        menu.Items.Add("显示小鲸鱼挂件", null, (_, _) => ShowWidget());
        menu.Items.Add("启动代理网关（7891）", null, (_, _) => StartGateway());
        menu.Items.Add("打开日志", null, (_, _) => { try { Process.Start("notepad.exe", Program.LogPath); } catch { } });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出（停止服务）", null, (_, _) => RequestExit());
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => RestoreFromWidget();

        Load += async (_, _) => await InitializeAsync();
        Resize += OnMainResize;
        FormClosing += OnFormClosing;
        FormClosed += (_, _) => { _tray.Visible = false; _tray.Dispose(); };
    }

    private static string FindProjectRoot()
    {
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 10 && !string.IsNullOrEmpty(dir); i++)
        {
            if (File.Exists(Path.Combine(dir, "src", "cli.mjs")) && File.Exists(Path.Combine(dir, "package.json")))
            {
                return dir;
            }
            dir = Directory.GetParent(dir)?.FullName ?? string.Empty;
        }
        return Directory.GetCurrentDirectory();
    }

    private void SetStatus(string text)
    {
        _status.Text = text;
        _status.Visible = text.Length > 0;
        if (text.Length > 0) _status.BringToFront();
        Program.Log($"status: {text.Replace('\n', ' ')}");
    }

    private async Task InitializeAsync()
    {
        try
        {
            if (!File.Exists(Path.Combine(_root, "src", "cli.mjs")))
            {
                SetStatus($"找不到项目文件：{_root}\n请把 exe 保留在项目 desktop 目录内。");
                return;
            }

            if (!await IsPortOpen(Program.Port))
            {
                Program.Log("port closed, spawning node server");
                _server = Process.Start(new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = $"src/cli.mjs serve --port {Program.Port}",
                    WorkingDirectory = _root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                });
                _ownsServer = _server is not null;
                if (_server is not null)
                {
                    _server.OutputDataReceived += (_, _) => { };
                    _server.ErrorDataReceived += (_, _) => { };
                    _server.BeginOutputReadLine();
                    _server.BeginErrorReadLine();
                }
            }
            else
            {
                Program.Log("port already open, reuse existing server");
            }

            var ready = false;
            for (var i = 0; i < 120; i++)
            {
                if (await HttpOk($"http://127.0.0.1:{Program.Port}/api/status?range=today"))
                {
                    ready = true;
                    break;
                }
                await Task.Delay(250);
            }
            Program.Log($"server ready={ready}");
            if (!ready)
            {
                SetStatus("驾驶舱服务未能在 30 秒内启动。\n请检查 Node 是否安装、7777 端口是否被占用。\n日志：" + Program.LogPath);
                return;
            }

            SetStatus("正在初始化界面…");
            var dataDir = Path.Combine(AppContext.BaseDirectory, "WebView2Data");
            Directory.CreateDirectory(dataDir);
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await _web.EnsureCoreWebView2Async(env);
            _web.DefaultBackgroundColor = Color.Transparent;
            _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _web.CoreWebView2.Settings.IsSwipeNavigationEnabled = false;
            _web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            _web.CoreWebView2.NewWindowRequested += (_, e) => { e.Handled = true; };
            _web.CoreWebView2.ProcessFailed += (_, e) => Program.Log($"PROCESS FAILED: {e.ProcessFailedKind} {e.Reason}");
            _web.CoreWebView2.NavigationCompleted += (_, e) =>
            {
                Program.Log($"navigation completed success={e.IsSuccess} error={e.WebErrorStatus}");
                if (!e.IsSuccess)
                {
                    _web.CoreWebView2.NavigateToString(
                        "<html><body style='font-family:Microsoft YaHei;background:#f1f4fd;color:#1b2342;padding:40px'>" +
                        "<h2>页面加载失败</h2><p>请确认 7777 端口未被拦截，或退出后重新打开。</p>" +
                        $"<p style='color:#8b93b8'>日志：{Program.LogPath}</p></body></html>");
                }
            };
            SetStatus("正在打开驾驶舱…");
            _web.CoreWebView2.Navigate($"http://127.0.0.1:{Program.Port}/");
            await Task.Delay(1200);
            SetStatus("");
            _web.BringToFront();
            Program.Log("navigate requested");
        }
        catch (Exception ex)
        {
            Program.Log($"INIT ERROR: {ex}");
            SetStatus($"初始化失败：{ex.Message}\n日志：{Program.LogPath}");
        }
    }

    private static async Task<bool> HttpOk(string url)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var response = await client.GetAsync(url);
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private static async Task<bool> IsPortOpen(int port)
    {
        try
        {
            using var client = new TcpClient();
            using var cts = new CancellationTokenSource(300);
            await client.ConnectAsync("127.0.0.1", port, cts.Token);
            return true;
        }
        catch { return false; }
    }

    private void StartGateway()
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "src/cli.mjs gateway serve",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            _tray.ShowBalloonTip(2500, "DSH 驾驶舱", "代理网关已启动：http://127.0.0.1:7891", ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"网关启动失败：{ex.Message}", "DSH 驾驶舱", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    internal void RestoreFromWidget()
    {
        try { _widget?.Hide(); } catch { }
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        ShowInTaskbar = true;
        Activate();
        _web.Focus();
        Program.Log("restored from widget");
    }

    internal void ShowWidget()
    {
        if (_widget is null || _widget.IsDisposed)
        {
            _widget = new WidgetForm(this, $"http://127.0.0.1:{Program.Port}", _widgetPosFile);
            _widget.FormClosed += (_, _) => _widget = null;
        }
        Hide();
        ShowInTaskbar = false;
        _widget.ShowWidget();
        Program.Log("main hidden, widget shown");
    }

    internal void RequestExit()
    {
        _exiting = true;
        try { _widget?.Close(); } catch { }
        Close();
    }

    private void OnMainResize(object? sender, EventArgs e)
    {
        if (_exiting) return;
        if (WindowState == FormWindowState.Minimized)
        {
            BeginInvoke(new Action(ShowWidget));
            return;
        }
        // 从任务栏等方式恢复主窗口时，收起挂件
        if (_widget is { Visible: true }) _widget.Hide();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        try { _widget?.Close(); } catch { }
        if (_ownsServer && _server is { HasExited: false })
        {
            try { _server.Kill(entireProcessTree: true); } catch { }
        }
        if (_server is not null) _server.Dispose();
        _tray.Visible = false;
        _tray.Dispose();
    }
}

/// <summary>小鲸鱼挂件：无边框圆角、置顶、可拖拽吸附，双击展开主窗口。</summary>
internal sealed class WidgetForm : Form
{
    private const int WidgetWidth = 400;
    private const int WidgetHeight = 300;
    private const int SnapMargin = 18;

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly MainForm _owner;
    private readonly string _baseUrl;
    private readonly string _posFile;
    private readonly ContextMenuStrip _menu;
    private bool _ready;

    public WidgetForm(MainForm owner, string baseUrl, string posFile)
    {
        _owner = owner;
        _baseUrl = baseUrl;
        _posFile = posFile;
        Text = "DSH 小鲸鱼挂件";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(WidgetWidth, WidgetHeight);
        BackColor = Color.FromArgb(241, 244, 253);
        AutoScaleMode = AutoScaleMode.None;
        Icon = Program.AppIcon();
        DoubleBuffered = true;
        _web.DefaultBackgroundColor = Color.Transparent;
        Controls.Add(_web);

        _menu = new ContextMenuStrip();
        _menu.Items.Add("打开驾驶舱", null, (_, _) => _owner.RestoreFromWidget());
        _menu.Items.Add("刷新数据", null, (_, _) => { try { _web.CoreWebView2?.Reload(); } catch { } });
        _menu.Items.Add("退出程序", null, (_, _) => _owner.RequestExit());

        var pos = LoadPosition();
        Location = pos;
        Load += async (_, _) => await InitializeAsync();
        Resize += (_, _) => ApplyRoundedRegion();
        FormClosed += (_, _) => _web.Dispose();
    }

    private async Task InitializeAsync()
    {
        try
        {
            var dataDir = Path.Combine(AppContext.BaseDirectory, "WebView2WidgetData");
            Directory.CreateDirectory(dataDir);
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await _web.EnsureCoreWebView2Async(env);
            _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            _web.CoreWebView2.WebMessageReceived += OnWebMessage;
            _web.CoreWebView2.Navigate($"{_baseUrl}/widget.html");
            _ready = true;
            Program.Log("widget initialized");
        }
        catch (Exception ex)
        {
            Program.Log($"WIDGET INIT ERROR: {ex}");
            _web.Visible = false;
            Controls.Add(new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Text = "小鲸鱼加载失败，右键退出后重试",
                ForeColor = Color.FromArgb(82, 92, 134),
            });
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.TryGetWebMessageAsString(); } catch { return; }
        if (string.IsNullOrWhiteSpace(raw)) return;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
            switch (type)
            {
                case "restore":
                    _owner.RestoreFromWidget();
                    break;
                case "menu":
                    _menu.Show(Cursor.Position);
                    break;
                case "move":
                    {
                        var dx = doc.RootElement.TryGetProperty("dx", out var x) ? x.GetInt32() : 0;
                        var dy = doc.RootElement.TryGetProperty("dy", out var y) ? y.GetInt32() : 0;
                        Location = new Point(Location.X + dx, Location.Y + dy);
                        break;
                    }
                case "dragend":
                    SnapToEdges();
                    SavePosition();
                    break;
            }
        }
        catch (Exception ex) { Program.Log($"widget message error: {ex.Message}"); }
    }

    private void SnapToEdges()
    {
        var screen = Screen.FromControl(this).WorkingArea;
        var x = Location.X;
        var y = Location.Y;
        if (Math.Abs(x - screen.Left) < SnapMargin) x = screen.Left;
        if (Math.Abs(screen.Right - (x + Width)) < SnapMargin) x = screen.Right - Width;
        if (Math.Abs(y - screen.Top) < SnapMargin) y = screen.Top;
        if (Math.Abs(screen.Bottom - (y + Height)) < SnapMargin) y = screen.Bottom - Height;
        Location = new Point(x, y);
    }

    private Point LoadPosition()
    {
        var screen = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        var fallback = new Point(screen.Right - WidgetWidth - SnapMargin, screen.Bottom - WidgetHeight - SnapMargin);
        try
        {
            if (File.Exists(_posFile))
            {
                var json = JsonDocument.Parse(File.ReadAllText(_posFile));
                var x = json.RootElement.GetProperty("x").GetInt32();
                var y = json.RootElement.GetProperty("y").GetInt32();
                var candidate = new Point(x, y);
                var testRect = new Rectangle(candidate, new Size(WidgetWidth, WidgetHeight));
                if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(testRect))) return candidate;
            }
        }
        catch { }
        return fallback;
    }

    private void SavePosition()
    {
        try
        {
            File.WriteAllText(_posFile, JsonSerializer.Serialize(new { x = Location.X, y = Location.Y }));
        }
        catch { }
    }

    private void ApplyRoundedRegion()
    {
        if (Width <= 0 || Height <= 0) return;
        using var path = new GraphicsPath();
        const int radius = 24;
        path.AddArc(0, 0, radius, radius, 180, 90);
        path.AddArc(Width - radius, 0, radius, radius, 270, 90);
        path.AddArc(Width - radius, Height - radius, radius, radius, 0, 90);
        path.AddArc(0, Height - radius, radius, radius, 90, 90);
        path.CloseAllFigures();
        Region = new Region(path);
    }

    public void ShowWidget()
    {
        Show();
        TopMost = true;
        BringToFront();
        if (_ready) { try { _web.CoreWebView2?.Reload(); } catch { } }
        ApplyRoundedRegion();
    }
}
