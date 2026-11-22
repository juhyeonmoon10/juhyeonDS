/* juhyeonDS - DS Ethernet to IPv4 via libslirp. GPL-3.0-or-later. */
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <poll.h>
#include <unistd.h>
#include <libslirp.h>

namespace
{
constexpr size_t kMaxFrame = 2048;
constexpr uint32_t kVirtualDns = 0x0a400002; // 10.64.0.2

uint16_t read16(const uint8_t* bytes)
{
    return (uint16_t(bytes[0]) << 8) | bytes[1];
}

bool publicIPv4(uint32_t ip)
{
    // IANA special-use addresses do not provide general Internet access.
    const uint8_t a = ip >> 24, b = ip >> 16, c = ip >> 8;
    return a != 0 && a != 10 && a != 127 && a < 224 &&
        !(a == 100 && (b & 0xc0) == 64) && !(a == 169 && b == 254) &&
        !(a == 172 && b >= 16 && b <= 31) &&
        !(a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)))) &&
        !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) &&
        !(a == 203 && b == 0 && c == 113);
}

bool localDestination(uint32_t ip)
{
    ifaddrs* interfaces = nullptr;
    if (getifaddrs(&interfaces) != 0) return true;
    bool found = false;
    for (auto* entry = interfaces; entry && !found; entry = entry->ifa_next)
        if (entry->ifa_addr && entry->ifa_addr->sa_family == AF_INET)
            found = ntohl(reinterpret_cast<sockaddr_in*>(entry->ifa_addr)->sin_addr.s_addr) == ip;
    freeifaddrs(interfaces);
    return found;
}

bool allowFrame(const uint8_t* frame, size_t length)
{
    if (read16(frame + 12) == 0x0806) return length >= 42; // virtual ARP
    if (read16(frame + 12) != 0x0800 || length < 34) return false;
    const uint8_t* ip = frame + 14;
    const size_t header = (ip[0] & 15) * 4;
    const size_t packet = read16(ip + 2);
    if ((ip[0] >> 4) != 4 || header != 20 || packet < header || packet > length - 14) return false;
    uint32_t destination;
    memcpy(&destination, ip + 16, sizeof(destination));
    destination = ntohl(destination);
    if (publicIPv4(destination)) return !localDestination(destination);

    // Allow only DNS at the virtual resolver and DHCP at broadcast / virtual gateway.
    if ((read16(ip + 6) & 0x3fff) || packet < header + 8) return false;
    const uint16_t port = read16(ip + header + 2);
    return (destination == kVirtualDns && port == 53 && (ip[9] == 17 || ip[9] == 6)) ||
           ((destination == 0xffffffff || destination == 0x0a400001) &&
            ip[9] == 17 && port == 67 && read16(ip + header) == 68);
}

bool writeAll(const uint8_t* bytes, size_t length)
{
    while (length)
    {
        const auto written = write(STDOUT_FILENO, bytes, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return false;
        bytes += written;
        length -= written;
    }
    return true;
}

ssize_t sendFrame(const void* bytes, size_t length, void*)
{
    if (length < 14 || length > 1514) return -1;
    uint8_t message[kMaxFrame + 2];
    message[0] = length >> 8;
    message[1] = length & 255;
    memcpy(message + 2, bytes, length);
    return writeAll(message, length + 2) ? static_cast<ssize_t>(length) : -1;
}

struct PollList
{
    std::array<pollfd, 256> entries{};
    nfds_t count;
};

int addPoll(slirp_os_socket fd, int events, void* opaque)
{
    auto& list = *static_cast<PollList*>(opaque);
    if (list.count == list.entries.size()) return -1;
    short flags = 0;
    if (events & SLIRP_POLL_IN) flags |= POLLIN;
    if (events & SLIRP_POLL_OUT) flags |= POLLOUT;
    if (events & SLIRP_POLL_PRI) flags |= POLLPRI;
    const auto index = list.count++;
    list.entries[index] = {fd, flags, 0};
    return index;
}

int pollEvents(int index, void* opaque)
{
    const auto& list = *static_cast<PollList*>(opaque);
    if (index < 0 || static_cast<nfds_t>(index) >= list.count) return 0;
    const auto flags = list.entries[index].revents;
    int events = 0;
    if (flags & POLLIN) events |= SLIRP_POLL_IN;
    if (flags & POLLOUT) events |= SLIRP_POLL_OUT;
    if (flags & POLLPRI) events |= SLIRP_POLL_PRI;
    if (flags & (POLLERR | POLLNVAL)) events |= SLIRP_POLL_ERR;
    if (flags & POLLHUP) events |= SLIRP_POLL_HUP;
    return events;
}

void forwardFrames(Slirp* slirp)
{
    PollList list;
    uint8_t input[8192];
    size_t pending = 0;
    for (;;)
    {
        list.entries[0] = {STDIN_FILENO, POLLIN, 0};
        list.count = 1;
        uint32_t timeout = 1000;
        slirp_pollfds_fill_socket(slirp, &timeout, addPoll, &list);
        const int result = poll(list.entries.data(), list.count, std::min(timeout, uint32_t(1000)));
        if (result < 0 && errno == EINTR) continue;
        slirp_pollfds_poll(slirp, result < 0, pollEvents, &list);
        if (result < 0) return;
        if (!(list.entries[0].revents & (POLLIN | POLLHUP | POLLERR))) continue;
        const auto count = read(STDIN_FILENO, input + pending, sizeof(input) - pending);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return;
        pending += count;
        size_t offset = 0;
        while (pending - offset >= 2)
        {
            const auto length = read16(input + offset);
            if (length < 14 || length > kMaxFrame) return;
            if (pending - offset < size_t(length) + 2) break;
            const auto* bytes = input + offset + 2;
            if (allowFrame(bytes, length)) slirp_input(slirp, bytes, length);
            offset += length + 2;
        }
        pending -= offset;
        memmove(input, input + offset, pending);
    }
}
}

int main()
{
    SlirpConfig config{};
    config.version = 6;
    config.in_enabled = true;
    config.vnetwork.s_addr = htonl(0x0a400000);
    config.vnetmask.s_addr = htonl(0xffffff00);
    config.vhost.s_addr = htonl(0x0a400001);
    config.vdhcp_start.s_addr = htonl(0x0a400010);
    config.vnameserver.s_addr = htonl(kVirtualDns);
    config.if_mtu = 1500;
    config.disable_host_loopback = true;
    SlirpCb callbacks{};
    callbacks.send_packet = sendFrame;
    callbacks.guest_error = [](const char*, void*) {};
    callbacks.clock_get_ns = [](void*) -> int64_t {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
    };
    callbacks.notify = [](void*) {};
    callbacks.register_poll_socket = [](slirp_os_socket, void*) {};
    callbacks.unregister_poll_socket = [](slirp_os_socket, void*) {};
    Slirp* slirp = slirp_new(&config, &callbacks, nullptr);
    if (!slirp) return 1;
    const uint8_t ready[2] = {0, 0};
    if (writeAll(ready, sizeof(ready))) forwardFrames(slirp);
    slirp_cleanup(slirp);
}
