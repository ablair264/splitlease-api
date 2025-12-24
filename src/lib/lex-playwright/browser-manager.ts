/**
 * Browser Manager for Lex Playwright Automation
 *
 * Manages browser instance lifecycle with session reuse for efficiency.
 * Handles login and maintains authenticated state.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";

const LEX_LOGIN_URL = "https://associate.lexautolease.co.uk/Login.aspx";
const LEX_QUOTE_URL = "https://associate.lexautolease.co.uk/Quotes/NewQuote.aspx";

export class LexBrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isLoggedIn: boolean = false;
  private lastLoginTime: number = 0;
  private static instance: LexBrowserManager | null = null;

  // Session timeout - re-login after 30 minutes
  private static SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): LexBrowserManager {
    if (!LexBrowserManager.instance) {
      LexBrowserManager.instance = new LexBrowserManager();
    }
    return LexBrowserManager.instance;
  }

  /**
   * Initialize browser if not already running
   */
  private async ensureBrowser(): Promise<void> {
    if (!this.browser) {
      console.log("[LexBrowser] Launching browser...");
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      this.page = await this.context.newPage();
      console.log("[LexBrowser] Browser launched successfully");
    }
  }

  /**
   * Check if session is still valid (not expired)
   */
  isSessionValid(): boolean {
    if (!this.isLoggedIn) return false;
    const elapsed = Date.now() - this.lastLoginTime;
    return elapsed < LexBrowserManager.SESSION_TIMEOUT_MS;
  }

  /**
   * Login to Lex Autolease
   */
  async login(): Promise<boolean> {
    const username = process.env.LEX_USERNAME;
    const password = process.env.LEX_PASSWORD;

    if (!username || !password) {
      throw new Error("LEX_USERNAME and LEX_PASSWORD environment variables must be set");
    }

    await this.ensureBrowser();

    if (!this.page) {
      throw new Error("Page not initialized");
    }

    try {
      console.log("[LexBrowser] Navigating to login page...");
      await this.page.goto(LEX_LOGIN_URL, { waitUntil: "load", timeout: 60000 });

      // Wait a moment for any overlays to appear
      await this.page.waitForTimeout(2000);

      console.log("[LexBrowser] Current URL:", this.page.url());

      // Handle cookie consent if present - must be done before login form is accessible
      console.log("[LexBrowser] Checking for cookie consent banner...");

      // Wait specifically for the Lex cookie consent to appear
      try {
        const cookieAccept = this.page.locator('#accept');
        await cookieAccept.waitFor({ state: 'visible', timeout: 5000 });
        console.log("[LexBrowser] Cookie consent found, clicking...");
        await cookieAccept.click();
        console.log("[LexBrowser] Cookie consent clicked");
        await this.page.waitForTimeout(1000);
      } catch {
        console.log("[LexBrowser] No cookie consent banner found, continuing...");
      }

      // Wait for login form to be ready
      console.log("[LexBrowser] Waiting for login form...");

      // First check if the element exists at all
      const loginFormExists = await this.page.locator("#txtUserName").count();
      console.log(`[LexBrowser] Login form elements found: ${loginFormExists}`);

      if (loginFormExists === 0) {
        // Take screenshot for debugging
        console.log("[LexBrowser] Login form not found, taking screenshot...");
        const screenshot = await this.page.screenshot({ fullPage: true });
        console.log("[LexBrowser] Screenshot taken, size:", screenshot.length);

        // Log page content for debugging
        const pageTitle = await this.page.title();
        console.log("[LexBrowser] Page title:", pageTitle);

        throw new Error("Login form not found on page");
      }

      await this.page.waitForSelector("#txtUserName", { state: 'visible', timeout: 30000 });

      // Fill login credentials
      console.log("[LexBrowser] Entering credentials...");
      await this.page.locator("#txtUserName").fill(username);
      await this.page.locator("#txtPassword").fill(password);

      // Click login button
      console.log("[LexBrowser] Clicking login button...");
      await this.page.locator("#btnLogon").click();

      // Wait for navigation after login
      await this.page.waitForLoadState("networkidle");

      // Check if login was successful by looking for quotes menu
      try {
        await this.page.locator("#ulQuotes_sub").waitFor({ timeout: 10000 });
        this.isLoggedIn = true;
        this.lastLoginTime = Date.now();
        console.log("[LexBrowser] Login successful");
        return true;
      } catch {
        // Check for error messages
        const errorText = await this.page.textContent("body");
        console.error("[LexBrowser] Login failed. Page content:", errorText?.substring(0, 500));
        this.isLoggedIn = false;
        return false;
      }
    } catch (error) {
      console.error("[LexBrowser] Login error:", error);
      this.isLoggedIn = false;
      throw error;
    }
  }

  /**
   * Get the authenticated page, logging in if necessary
   */
  async getPage(): Promise<Page> {
    await this.ensureBrowser();

    // Re-login if session expired or not logged in
    if (!this.isSessionValid()) {
      console.log("[LexBrowser] Session expired or not logged in, logging in...");
      const success = await this.login();
      if (!success) {
        throw new Error("Failed to login to Lex Autolease");
      }
    }

    if (!this.page) {
      throw new Error("Page not initialized");
    }

    return this.page;
  }

  /**
   * Navigate to new quote page
   */
  async navigateToNewQuote(): Promise<void> {
    const page = await this.getPage();

    // Click on New Quote link
    console.log("[LexBrowser] Navigating to New Quote...");
    await page.locator("#ulQuotes_sub").getByRole("link", { name: "New quote" }).click();
    await page.waitForLoadState("networkidle");
    console.log("[LexBrowser] On New Quote page");
  }

  /**
   * Check if currently on the quote page
   */
  async isOnQuotePage(): Promise<boolean> {
    if (!this.page) return false;
    const url = this.page.url();
    return url.includes("NewQuote.aspx") || url.includes("QuoteLine.aspx");
  }

  /**
   * Force re-login (useful after errors)
   */
  async forceRelogin(): Promise<boolean> {
    this.isLoggedIn = false;
    this.lastLoginTime = 0;
    return this.login();
  }

  /**
   * Clean up browser resources
   */
  async cleanup(): Promise<void> {
    console.log("[LexBrowser] Cleaning up...");

    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.isLoggedIn = false;
    this.lastLoginTime = 0;
    LexBrowserManager.instance = null;
    console.log("[LexBrowser] Cleanup complete");
  }

  /**
   * Take a screenshot for debugging
   */
  async takeScreenshot(name: string): Promise<Buffer | null> {
    if (!this.page) return null;
    try {
      return await this.page.screenshot({ fullPage: true });
    } catch (error) {
      console.error(`[LexBrowser] Failed to take screenshot ${name}:`, error);
      return null;
    }
  }
}

// Export singleton getter
export function getBrowserManager(): LexBrowserManager {
  return LexBrowserManager.getInstance();
}
