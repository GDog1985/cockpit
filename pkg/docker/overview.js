/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2015 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

define([
    "jquery",
    "base1/cockpit",
    "base1/mustache",
    "docker/util",
    "docker/run",
    "docker/search",
    "docker/docker",
    "shell/controls",
    "base1/bootstrap-select",
], function($, cockpit, Mustache, util, run_image, search_image, docker, controls) {
    var _ = cockpit.gettext;
    var C_ = cockpit.gettext;

    /* OVERVIEW PAGE
     */

    function init_overview (client) {

        var danger_enabled = false;

        function set_danger_enabled(val) {
            danger_enabled = val;
            $('#containers-containers button.enable-danger').toggleClass('active', danger_enabled);
            $("#containers-containers td.container-col-actions").toggle(!danger_enabled);
            $("#containers-containers td.container-col-danger").toggle(danger_enabled);
        }

        util.setup_danger_button('#containers-containers', "#containers",
                                 function() {
                                     set_danger_enabled(!danger_enabled);
                                 });

        $('#containers-containers-filter').on('change', function () {
            var filter = $(this).val();
            $("#containers-containers table").toggleClass("filter-unimportant", filter === "running");
        });

        $('#containers-images-search').on("click", function() {
            search_image(client);
            return false;
        });

        $('.selectpicker').selectpicker();

        var reds = [ "#250304",
                     "#5c080c",
                     "#970911",
                     "#ce0e15",
                     "#ef2930",
                     "#f36166",
                     "#f7999c",
                     "#fbd1d2"
                   ];

        var blues = [ "#006bb4",
                      "#008ff0",
                      "#2daaff",
                      "#69c2ff",
                      "#a5daff",
                      "#e1f3ff",
                      "#00243c",
                      "#004778"
                    ];

        function highlight_container_row(event, id) {
            id = client.container_from_cgroup(id) || id;
            $('#containers-containers tr').removeClass('highlight');
            $('#' + id).addClass('highlight');
        }

        var cpu_plot = client.setup_cgroups_plot ('#containers-cpu-graph', 4, blues.concat(blues));
        $(cpu_plot).on('update-total', function (event, total) {
            $('#containers-cpu-text').text(util.format_cpu_usage(total));
        });
        $(cpu_plot).on('highlight', highlight_container_row);

        var mem_plot = client.setup_cgroups_plot ('#containers-mem-graph', 0, blues.concat(blues));
        $(mem_plot).on('update-total', function (event, total) {
            $('#containers-mem-text').text(cockpit.format_bytes(total, 1024));
        });
        $(mem_plot).on('highlight', highlight_container_row);

        function render_container(id, container) {
            util.render_container(client, $('#containers-containers'),
                                  "", id, container, danger_enabled);
        }

        function render_image(id, image) {
            var tr = $("#" + id);

            if (!image ||
                !image.RepoTags ||
                image.RepoTags[0] == "<none>:<none>") {
                tr.remove();
                return;
            }

            var added = false;
            if (!tr.length) {
                var button = $('<button class="btn btn-default btn-control fa fa-play">').
                    on("click", function() {
                        run_image(client, id);
                        return false;
                    });
                tr = $('<tr id="' + id + '">').append(
                    $('<td class="image-col-tags">'),
                    $('<td class="image-col-created">'),
                    $('<td class="image-col-size-graph">'),
                    $('<td class="image-col-size-text">'),
                    $('<td class="cell-buttons">').append(button));
                tr.on('click', function(event) {
                    cockpit.location.go([ 'image', id ]);
                });

                added = true;
            }

            var row = tr.children("td");
            $(row[0]).html(util.multi_line(image.RepoTags));

            /* if an image is older than two days, don't show the time */
            var threshold_date = new Date(image.Created * 1000);
            threshold_date.setDate(threshold_date.getDate() + 2);

            if (threshold_date > (new Date())) {
                $(row[1]).text(new Date(image.Created * 1000).toLocaleString());
            } else {
                var creation_date = new Date(image.Created * 1000);

                /* we hide the time, so put full timestamp in the hover text */
                $(row[1])
                    .text(creation_date.toLocaleDateString())
                    .attr("title", creation_date.toLocaleString());
            }

            $(row[2]).children("div").attr("value", image.VirtualSize);
            $(row[3]).text(cockpit.format_bytes(image.VirtualSize, 1024));

            if (added) {
                util.insert_table_sorted($('#containers-images table'), tr);
            }
        }

        $('#containers-containers table tbody tr').remove();
        $('#containers-images table tbody tr').remove();

        /* Every time a container appears, disappears, changes */
        $(client).on('container.containers', function(event, id, container) {
            render_container(id, container);
        });

        /* Every time a image appears, disappears, changes */
        $(client).on('image.containers', function(event, id, image) {
            render_image(id, image);
        });

        var id;
        $("#containers-containers button.enable-danger").toggle(false);
        for (id in client.containers) {
            render_container(id, client.containers[id]);
        }

        for (id in client.images) {
            render_image(id, client.images[id]);
        }

        // Render storage, throttle update on events

        function render_storage() {
            client.info().done(function(data) {
                var resp = data && JSON.parse(data);
                if (resp['Driver'] !== "devicemapper") {
                    // TODO: None of the other graphdrivers currently
                    // report size information.
                    $('#containers-storage .bar').html();
                    $('#containers-storage .data').html("Unknown");
                }

                var used;
                var total;
                var avail;
                $.each(resp['DriverStatus'], function (index, value) {
                    if (value && value[0] == "Data Space Total")
                        total = value[1];
                    else if (value && value[0] == "Data Space Used")
                        used = value[1];
                    else if (value && value[0] == "Data Space Available")
                        avail = value[1];
                });

                if (used && total && docker) {

                    var b_used = docker.bytes_from_format(used);
                    var b_total = docker.bytes_from_format(total);

                    // Prefer available if present as that will be accurate for
                    // sparse file based devices
                    if (avail) {
                        $('#containers-storage').tooltip('destroy');
                        b_total = docker.bytes_from_format(avail);
                        total = cockpit.format_bytes(b_used + b_total);
                    } else {
                        var warning = _("WARNING: Docker may be reporting the size it has allocated to it's storage pool using sparse files, not the actual space available to the underlying storage device.");
                        $('#containers-storage').tooltip({ title : warning });
                    }

                    var formated = used + " / " + total;
                    var bar_row = controls.BarRow();
                    bar_row.attr("value", b_used + "/" + b_total);
                    bar_row.toggleClass("bar-row-danger", used > 0.95 * total);

                    $('#containers-storage .bar').html(bar_row);
                    $('#containers-storage .data').html(formated);
                } else {
                    $('#containers-storage .bar').html();
                    $('#containers-storage .data').html("Unknown");
                }
            });
        }

        function throttled_render_storage() {
            var self = this;
            var timer = null;
            var missed = false;

            var throttle = function() {
                if (!timer) {
                    render_storage();
                    timer = window.setTimeout(function () {
                        var need_call = missed;
                        missed = false;
                        timer = null;
                        if (need_call && client)
                            throttle();

                    }, 10000);
                } else {
                    missed = true;
                }
            };

            return throttle;
        }

        render_storage();
        $(client).on('event.containers', throttled_render_storage());

        function hide() {
            $('#containers').hide();
        }

        function show() {
            $('#containers').show();
            cpu_plot.start();
            mem_plot.start();
        }

        return {
            show: show,
            hide: hide
        };
    }

    return {
        init: init_overview
    };
});
