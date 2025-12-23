class Podshift < Formula
  desc "Migrate Docker Compose projects to Podman-friendly workflows"
  homepage "https://github.com/raymonepping/podshift"
  url "https://registry.npmjs.org/podshift/-/podshift-0.1.0.tgz"
  sha256 "c8d3eae160a892e32837db3dcae515e843e5383fef52b8141940c8bcf8b6d59f"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  test do
    assert_match "podshift", shell_output("#{bin}/podshift --help")
  end
end
