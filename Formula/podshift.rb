class Podshift < Formula
  desc "Migrate Docker Compose projects to Podman-friendly workflows"
  homepage "https://github.com/raymonepping/podshift"
  url "https://github.com/raymonepping/podshift/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "30a1d76705a6f5c06fb0db042e5cfc2543245a16606ffbdfcbe44289b1819b4f"
  license "MIT"

  depends_on "node@22"

  def install
    ENV.prepend_path "PATH", Formula["node@22"].opt_bin
    system "npm", "install", *std_npm_args
  end

  test do
    (testpath/"docker-compose.yml").write <<~YML
      services:
      app:
        image: alpine
    YML

    out = shell_output("#{bin}/podshift candidates --root #{testpath} --max-entries 200 --max-depth 4")
    assert_match "Projects found:", out
  end

end
