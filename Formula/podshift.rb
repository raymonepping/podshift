class Podshift < Formula
  desc "Migrate Docker Compose projects to Podman-friendly workflows"
  homepage "https://github.com/raymonepping/podshift"
  url "https://github.com/raymonepping/podshift/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "5fb07e174a2b885e3d0c64b732c3a29b14da9156f68548d257798fe5ca2e4171"
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
